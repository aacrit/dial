#!/usr/bin/env node
// Makes Dial's prepared recordings (T5): each Repertory work rendered once,
// by the same pipeline the tab runs, so Tune in can play at once on any
// device. Audio is never committed (rule 8): the masters go to --out
// (default D:/dial-recordings), are published as release assets by
// scripts/publish-recordings.mjs, and are pinned in recordings.lock.json.
//
//   node scripts/render-recordings.mjs [--only cave,crito] [--device auto|cpu|dml] [--out DIR] [--fresh]
//   node scripts/render-recordings.mjs --compare cave:40      GPU against CPU on a work's first 40 lines
//   node scripts/render-recordings.mjs --repro cave:30        re-render the first 30 lines, compare with the master
//   node scripts/render-recordings.mjs --lock [--date YYYY-MM-DD]   write recordings.lock.json from --out
//
// The pipeline, identical to the tab's (web/src/main.ts, narrate.worker.ts):
// the work's text (web/public/works/<slug>.txt) -> segment() -> tryCast()
// with the catalogue's cast sheet (CAST_ENGINE_VERSION) -> Kokoro-82M q8,
// the pinned model and voice files, each cue rendered alone in its cast
// voice at the voice's own pace -> the pause table's silence after every
// line. One work at a time, one process. The device is the CPU
// (onnxruntime-node) or, with --device dml or auto, the GPU through
// DirectML; if the GPU provider fails to load or to run, the work is made
// again on the CPU, and the manifest records which made it.
//
// Encoding: Opus at 48 kbps mono in WebM, by ffmpeg-static (a build-tool
// binary, GPL-3.0-or-later, never shipped to listeners). The recording is
// cut into parts of about a minute, always at the start of a line, so the
// page can start playing after one small download and every line's speech
// lies inside one part.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The tab's own TypeScript runs here: re-run with type transforms, and the
// voice table served as the page's build serves it.
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
register("./lib/voice-table-hooks.mjs", import.meta.url);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { segment } = await imp("web/src/engine/segment.ts");
const { tryCast, CAST_ENGINE_VERSION } = await imp("web/src/engine/cast.ts");
const { WORKS } = await imp("web/src/catalogue.ts");
const T = await imp("web/src/recording/timing.ts");
const { MODEL_FILES, REPO, REVISION, VOICES } = await imp("scripts/fetch-voice.mjs");
const { lockFrom, RELEASE_REPO } = await imp("scripts/lib/recordings-lock.mjs");

export const SR = T.RECORDING_RATE;
export const BITRATE = 48000;
export const PART_SECONDS = 60;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const pkgVersion = (name) => JSON.parse(readFileSync(path.join(repoRoot, "node_modules", name, "package.json"), "utf8")).version;
/** Today in this machine's local time, YYYY-MM-DD: the day the maker made it, which the Bookplate prints (never the UTC date). */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const today = () => localDate();
const r3 = (x) => Math.round(x * 1000) / 1000;

function args() {
  const a = process.argv.slice(2);
  const val = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const pair = (k) => {
    const v = val(k);
    if (!v) return null;
    const [slug, n] = v.split(":");
    return { slug, n: Number(n ?? 40) };
  };
  return {
    only: val("--only")?.split(","),
    device: val("--device", "auto"),
    out: path.resolve(val("--out", "D:/dial-recordings")),
    fresh: a.includes("--fresh"),
    compare: pair("--compare"),
    repro: pair("--repro"),
    lock: a.includes("--lock"),
    date: val("--date"),
    // T5b: a suffix on the release tag, so a lock that adds the m4a set does not disturb the Opus assets already published under the plain date tag (CoS decision H).
    tagSuffix: val("--tag-suffix", ""),
    threads: Number(val("--threads", Math.max(4, Math.floor(os.availableParallelism() / 2)))),
  };
}

// ---- the voice --------------------------------------------------------------

function checkPins() {
  const cacheDir = path.join(repoRoot, ".cache", "kokoro");
  for (const [file, pin] of Object.entries(MODEL_FILES)) {
    const p = path.join(cacheDir, REVISION, file);
    if (!existsSync(p)) throw new Error(`render-recordings: ${file} is not staged; run node scripts/fetch-voice.mjs first`);
    if (sha256(readFileSync(p)) !== pin) throw new Error(`render-recordings: ${file} does not match its pin in fetch-voice.mjs`);
  }
  for (const [id, pin] of Object.entries(VOICES)) {
    const p = path.join(repoRoot, "node_modules", "kokoro-js", "voices", `${id}.bin`);
    if (sha256(readFileSync(p)) !== pin) throw new Error(`render-recordings: voice ${id} does not match its pin in fetch-voice.mjs`);
  }
  return cacheDir;
}

/** Kokoro on `device` ("cpu" or "dml"). Throws when the provider cannot load the model. */
async function loadTts(device, threads) {
  const cacheDir = checkPins();
  const { env, StyleTextToSpeech2Model, AutoTokenizer } = await import("@huggingface/transformers");
  const { KokoroTTS } = await import("kokoro-js");
  env.allowRemoteModels = false;
  env.localModelPath = cacheDir;
  const model = await StyleTextToSpeech2Model.from_pretrained(REVISION, {
    dtype: "q8",
    device,
    session_options: device === "cpu" ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {},
  });
  const tokenizer = await AutoTokenizer.from_pretrained(REVISION);
  return new KokoroTTS(model, tokenizer);
}

function engineOf(device, threads) {
  return {
    cast: CAST_ENGINE_VERSION,
    model: `${REPO}@${REVISION}`,
    modelSha256: MODEL_FILES["onnx/model_quantized.onnx"],
    dtype: "q8",
    kokoroJs: pkgVersion("kokoro-js"),
    runtime: `onnxruntime-node ${pkgVersion("onnxruntime-node")}, @huggingface/transformers ${pkgVersion("@huggingface/transformers")}`,
    device: device === "cpu" ? `cpu (${threads} threads)` : `gpu (${device === "dml" ? "DirectML" : device})`,
  };
}

// ---- the pipeline -------------------------------------------------------------

/** A work's lines exactly as the tab computes them: cues, cast, and each line's hash. */
export async function linesOf(work) {
  const source = readFileSync(path.join(repoRoot, "web", "public", "works", `${work.slug}.txt`), "utf8");
  const cues = segment(source);
  const cast = tryCast(cues, work.cast);
  if (!cast) throw new Error(`render-recordings: ${work.slug} cannot be cast`);
  const hashes = await Promise.all(cues.map((c, i) => T.cueHash(c, cast.voices[i])));
  return { cues, cast, hashes, digest: await T.cuesDigest(hashes) };
}

/** Renders cues [0, n) of a work, each alone in its cast voice at speed 1.0, as the tab does. */
async function renderCues(tts, lines, n, onCue) {
  const out = [];
  const memo = new Map();
  for (let i = 0; i < n; i++) {
    const cue = lines.cues[i];
    const voice = lines.cast.voices[i];
    const key = `${voice}\u0000${cue.spoken}`;
    if (!memo.has(key)) {
      const raw = await tts.generate(cue.spoken, { voice });
      if (raw.sampling_rate !== SR) throw new Error(`render-recordings: sample rate ${raw.sampling_rate}`);
      const audio = new Float32Array(raw.audio);
      if (audio.some((x) => !Number.isFinite(x))) throw new Error(`render-recordings: line ${i + 1} has non-finite samples`);
      memo.set(key, audio);
    }
    out.push(memo.get(key));
    onCue?.(i);
  }
  return out;
}

const pauseSamples = (ms) => Math.round((ms / 1000) * SR);

/** Encodes Float32 mono samples at 24 kHz to Opus in WebM, byte for byte the same for the same samples. */
export function encodeOpus(samples, file) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", "pipe:0",
      "-c:a", "libopus", "-b:a", String(BITRATE), "-vbr", "on", "-application", "audio", "-frame_duration", "20",
      "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
      "-f", "webm", file,
    ], { stdio: ["pipe", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code} for ${file}`))));
    p.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  });
}

function ffmpegPath() {
  // An optional dependency: the gate never needs it, and its binary download may fail on a machine that only builds.
  let bin;
  try {
    bin = createRequire(import.meta.url)("ffmpeg-static");
  } catch {
    bin = null;
  }
  if (!bin || !existsSync(bin)) throw new Error("render-recordings: ffmpeg-static is not installed. It is an optional build tool: run npm install --include=optional (its postinstall downloads the ffmpeg binary), then render again.");
  return bin;
}

/** Makes one work's recording in dir: parts, index.json and manifest.json. */
async function renderWork(work, device, threads, dir) {
  const lines = await linesOf(work);
  let used = device;
  let tts;
  let audio;
  const t0 = performance.now();
  for (;;) {
    try {
      tts ??= await loadTts(used, threads);
      let last = performance.now();
      audio = await renderCues(tts, lines, lines.cues.length, (i) => {
        if (performance.now() - last > 30_000 || i === lines.cues.length - 1) {
          last = performance.now();
          console.log(`render-recordings: ${work.slug} line ${i + 1} of ${lines.cues.length} (${used}, ${((performance.now() - t0) / 1000).toFixed(0)} s)`);
        }
      });
      break;
    } catch (err) {
      if (used === "cpu") throw err;
      console.warn(`render-recordings: the ${used} provider failed (${err.message ?? err}); making ${work.slug} on the CPU`);
      used = "cpu";
      tts = undefined;
    }
  }
  const renderSeconds = (performance.now() - t0) / 1000;

  // Lines, then parts cut at line starts.
  const table = audio.map((a, i) => ({ speech: a.length, pause: pauseSamples(lines.cues[i].pauseAfterMs) }));
  const breaks = T.partBreaks(table, SR, PART_SECONDS);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const idxLines = [];
  let at = 0;
  table.forEach((l, i) => {
    idxLines.push({ at, speech: l.speech, pause: l.pause, hash: lines.hashes[i] });
    at += l.speech + l.pause;
  });
  const parts = [];
  const e0 = performance.now();
  for (let p = 0; p < breaks.length; p++) {
    const from = breaks[p];
    const to = breaks[p + 1] ?? table.length;
    const start = idxLines[from].at;
    const end = to < table.length ? idxLines[to].at : at;
    const samples = new Float32Array(end - start);
    for (let i = from; i < to; i++) samples.set(audio[i], idxLines[i].at - start);
    const file = `part${p}.webm`;
    await encodeOpus(samples, path.join(dir, file));
    const buf = readFileSync(path.join(dir, file));
    if (buf.length >= 20 * 1024 * 1024) throw new Error(`render-recordings: ${file} is over 20 MiB`);
    parts.push({ file, start: start / SR, seconds: (end - start) / SR, from, to, bytes: buf.length, sha256: sha256(buf) });
  }
  const encodeSeconds = (performance.now() - e0) / 1000;

  const engine = engineOf(used, threads);
  const index = {
    format: T.RECORDING_FORMAT,
    slug: work.slug,
    made: today(),
    engine,
    sampleRate: SR,
    samples: at,
    digest: lines.digest,
    codec: "opus/webm",
    bitrate: BITRATE,
    parts,
    lines: idxLines,
  };
  const problem = T.indexProblem(index, { slug: work.slug, digest: lines.digest, lines: lines.cues.length, castVersion: CAST_ENGINE_VERSION });
  if (problem) throw new Error(`render-recordings: ${work.slug} index is not sound: ${problem}`);
  const indexText = JSON.stringify(index) + "\n";
  writeFileSync(path.join(dir, "index.json"), indexText);

  const manifest = {
    slug: work.slug,
    title: work.title,
    translator: work.translator,
    made: index.made,
    engine,
    provider: used,
    requested: device,
    ffmpeg: `ffmpeg-static ${pkgVersion("ffmpeg-static")} (GPL-3.0-or-later build tool)`,
    encoder: { codec: "libopus", container: "webm", bitrate: BITRATE, channels: 1, input_rate: SR, part_seconds: PART_SECONDS },
    cast: { narrator: lines.cast.narrator, parts: lines.cast.parts.map((p) => ({ speaker: p.speaker, voice: p.voice })), voices: [...new Set(lines.cast.voices)] },
    lines: lines.cues.length,
    audio_seconds: r3(at / SR),
    render_seconds: r3(renderSeconds),
    encode_seconds: r3(encodeSeconds),
    rtf: r3(renderSeconds / (audio.reduce((n, a) => n + a.length, 0) / SR)),
    digest: lines.digest,
    index: { file: "index.json", bytes: Buffer.byteLength(indexText), sha256: sha256(indexText) },
    parts: parts.map(({ file, bytes, sha256: s, seconds }) => ({ file, bytes, sha256: s, seconds: r3(seconds) })),
    total_bytes: parts.reduce((n, p) => n + p.bytes, Buffer.byteLength(indexText)),
    // Per line, the hash of its samples as rendered (Float32), so --repro can say whether Kokoro repeats itself.
    line_pcm_sha256: audio.map((a) => sha256(Buffer.from(a.buffer, a.byteOffset, a.byteLength))),
  };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  console.log(`render-recordings: ${work.slug} made on ${used}: ${manifest.audio_seconds} s of audio in ${manifest.render_seconds} s (RTF ${manifest.rtf}), ${parts.length} parts, ${(manifest.total_bytes / 1e6).toFixed(2)} MB`);
  return manifest;
}

// ---- checks -------------------------------------------------------------------

/** Level and silence of one line: active RMS in dBFS, peak, and the share of 20 ms frames below -50 dBFS. */
export function lineStats(a) {
  const frame = Math.round(SR * 0.02);
  let sum = 0;
  let peak = 0;
  let silent = 0;
  let frames = 0;
  for (let f = 0; f + frame <= a.length; f += frame) {
    let e = 0;
    for (let i = f; i < f + frame; i++) {
      e += a[i] * a[i];
      peak = Math.max(peak, Math.abs(a[i]));
    }
    frames++;
    if (10 * Math.log10(e / frame + 1e-12) < -50) silent++;
    else sum += e;
  }
  const active = (frames - silent) * frame;
  return { seconds: a.length / SR, dbfs: active ? 10 * Math.log10(sum / active + 1e-12) : -120, peak, silence: frames ? silent / frames : 1 };
}

/** GPU against CPU on a work's first n lines: the same hashes, durations within 1%, and no artefact by level or silence. */
async function compare({ slug, n }, threads) {
  const work = WORKS.find((w) => w.slug === slug);
  const lines = await linesOf(work);
  n = Math.min(n, lines.cues.length);
  const run = async (device) => {
    const tts = await loadTts(device, threads);
    const t0 = performance.now();
    const audio = await renderCues(tts, lines, n);
    return { audio, seconds: (performance.now() - t0) / 1000 };
  };
  const cpu = await run("cpu");
  let gpu;
  try {
    gpu = await run("dml");
  } catch (err) {
    // The GPU provider could not make these lines: recorded, and every work is made on the CPU.
    const report = { slug, lines: n, ok: false, provider: "dml", reason: String(err.message ?? err), cpu: { render_seconds: r3(cpu.seconds) } };
    mkdirSync(path.join(repoRoot, "reports", "recordings"), { recursive: true });
    writeFileSync(path.join(repoRoot, "reports", "recordings", `compare-${slug}.json`), JSON.stringify(report, null, 1) + "\n");
    console.log(`render-recordings: the DirectML provider failed: ${report.reason}`);
    return report;
  }
  const rows = cpu.audio.map((a, i) => {
    const c = lineStats(a);
    const g = lineStats(gpu.audio[i]);
    return { line: i + 1, cpu: c, gpu: g, samples_ratio: gpu.audio[i].length / a.length };
  });
  const total = (xs) => xs.reduce((s, a) => s + a.length, 0) / SR;
  const cpuS = total(cpu.audio);
  const gpuS = total(gpu.audio);
  const worstDb = Math.max(...rows.map((r) => Math.abs(r.gpu.dbfs - r.cpu.dbfs)));
  const worstSilence = Math.max(...rows.map((r) => Math.abs(r.gpu.silence - r.cpu.silence)));
  const worstLine = Math.max(...rows.map((r) => Math.abs(r.samples_ratio - 1)));
  const peak = Math.max(...rows.map((r) => r.gpu.peak));
  const identical = rows.filter((r, i) => sha256(Buffer.from(cpu.audio[i].buffer)) === sha256(Buffer.from(gpu.audio[i].buffer))).length;
  const report = {
    slug,
    lines: n,
    digest: lines.digest,
    hashes_identical: true, // one computation: the hashes depend on the text and the cast, never the device
    cpu: { audio_seconds: r3(cpuS), render_seconds: r3(cpu.seconds), rtf: r3(cpu.seconds / cpuS) },
    gpu: { audio_seconds: r3(gpuS), render_seconds: r3(gpu.seconds), rtf: r3(gpu.seconds / gpuS) },
    duration_diff: r3(Math.abs(gpuS - cpuS) / cpuS),
    worst_line_duration_diff: r3(worstLine),
    worst_line_level_diff_db: r3(worstDb),
    worst_line_silence_share_diff: r3(worstSilence),
    gpu_peak: r3(peak),
    lines_bit_identical: identical,
  };
  report.ok = report.duration_diff <= 0.01 && worstDb <= 1.5 && worstSilence <= 0.1 && peak <= 1.0;
  mkdirSync(path.join(repoRoot, "reports", "recordings"), { recursive: true });
  writeFileSync(path.join(repoRoot, "reports", "recordings", `compare-${slug}.json`), JSON.stringify({ ...report, rows }, null, 1) + "\n");
  console.log(JSON.stringify(report, null, 1));
  return report;
}

/** Re-renders a master's first n lines on the device that made it and compares their samples. */
async function repro({ slug, n }, out, threads) {
  const manifest = JSON.parse(readFileSync(path.join(out, slug, "manifest.json"), "utf8"));
  const work = WORKS.find((w) => w.slug === slug);
  const lines = await linesOf(work);
  const tts = await loadTts(manifest.provider, threads);
  n = Math.min(n, lines.cues.length);
  const audio = await renderCues(tts, lines, n);
  const same = audio.filter((a, i) => sha256(Buffer.from(a.buffer, a.byteOffset, a.byteLength)) === manifest.line_pcm_sha256[i]).length;
  const report = {
    slug,
    provider: manifest.provider,
    lines: n,
    digest_same: lines.digest === manifest.digest,
    line_samples_identical: same,
    durations_identical: audio.every((a, i) => {
      const idx = JSON.parse(readFileSync(path.join(out, slug, "index.json"), "utf8"));
      return idx.lines[i].speech === a.length;
    }),
  };
  mkdirSync(path.join(repoRoot, "reports", "recordings"), { recursive: true });
  writeFileSync(path.join(repoRoot, "reports", "recordings", `repro-${slug}.json`), JSON.stringify(report, null, 1) + "\n");
  console.log(JSON.stringify(report, null, 1));
}

async function main() {
  const a = args();
  if (a.lock) {
    const lock = lockFrom(a.out, WORKS.map((w) => w.slug), { castVersion: CAST_ENGINE_VERSION, date: a.date ?? today(), repo: RELEASE_REPO, tagSuffix: a.tagSuffix });
    writeFileSync(path.join(repoRoot, "recordings.lock.json"), JSON.stringify(lock, null, 1) + "\n");
    console.log(`render-recordings: wrote recordings.lock.json for ${lock.tag}`);
    return;
  }
  if (a.compare) return void (await compare(a.compare, a.threads));
  if (a.repro) return void (await repro(a.repro, a.out, a.threads));
  const device = a.device === "auto" ? "dml" : a.device;
  mkdirSync(a.out, { recursive: true });
  const works = WORKS.filter((w) => !a.only || a.only.includes(w.slug));
  const summary = [];
  for (const work of works) {
    const dir = path.join(a.out, work.slug);
    if (!a.fresh && existsSync(path.join(dir, "manifest.json"))) {
      const m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
      const { digest } = await linesOf(work);
      if (m.digest === digest && m.engine.cast === CAST_ENGINE_VERSION) {
        console.log(`render-recordings: ${work.slug} is already made (${m.provider}); --fresh makes it again`);
        summary.push(m);
        continue;
      }
    }
    summary.push(await renderWork(work, device, a.threads, dir));
  }
  for (const m of summary) console.log(`${m.slug}: ${m.provider}, ${m.audio_seconds} s audio, render ${m.render_seconds} s, ${m.parts.length} parts, ${(m.total_bytes / 1e6).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
