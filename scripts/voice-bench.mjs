#!/usr/bin/env node
// Voice bench (T2c part 1): renders one fixed passage in every English voice
// kokoro-js ships and measures each, so casting reads numbers instead of
// guesses. Writes design/voices.json (measured source data, tracked) and the
// narrator audition clips under reports/bench/ (gitignored; audio is never
// committed, rule 8).
//
//   node scripts/voice-bench.mjs [--only am_puck,af_heart] [--fresh]
//
// Offline: the same Kokoro-82M q8 model the tab runs, from .cache/ (staged
// and pinned by scripts/fetch-voice.mjs; this refuses a mismatched byte), on
// the CPU through onnxruntime-node, one process, 4 threads, no GPU. Speed is
// always 1.0: a voice is measured at its own natural pace and never stretched.
// Each cue is rendered alone, exactly as the tab renders it
// (web/src/narrate.worker.ts), from web/src/engine/segment.ts's cues.
// Results are kept per voice in reports/bench/partial.json, so an
// interrupted run resumes where it stopped (--fresh starts over).
// Measurement method: scripts/lib/voice-measure.mjs.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// segment.ts and wav.ts are the tab's own TypeScript. Node 22 runs them with
// --experimental-transform-types (not plain stripping: wav.ts has a parameter
// property), so the bench re-runs itself with that flag.
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { segment } = await imp("web/src/engine/segment.ts");
const { encodeWav, assemble } = await imp("web/src/engine/wav.ts");
const { MODEL_FILES, REPO, REVISION } = await imp("scripts/fetch-voice.mjs");
const M = await imp("scripts/lib/voice-measure.mjs");

const SR = 24000;
const THREADS = 4;
const outDir = path.join(repoRoot, "reports", "bench");
const partialFile = path.join(outDir, "partial.json");
const voiceDir = path.join(repoRoot, "node_modules", "kokoro-js", "voices");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;

// ---- hexgrad's own table, transcribed from VOICES.md (offline). Its grades
// estimate the quality and quantity of each voice's TRAINING DATA, not how
// natural the voice sounds (void news, ON-AIR-RADIO.md "Voices").
export const HEXGRAD_TABLE = {
  source: "https://huggingface.co/hexgrad/Kokoro-82M/raw/main/VOICES.md",
  repo_commit: "f3ff3571791e39611d31c381e3a41a3af07b4987",
  sha256: "ec7e4941ad7e194af61e3455928528a9ff5360c7c505e412efab27d6a69ea106",
  fetched: "2026-09-26",
  note: "grade, target quality and training duration are hexgrad's estimates of each voice's training data. hexgrad's SHA256 column (a prefix) is of the PyTorch .pt voice, not kokoro-js's .bin, so it is kept only for reference.",
};
// id: [target quality, training duration, overall grade, hexgrad .pt sha256 prefix]
export const HEXGRAD = {
  af_heart: [null, null, "A", "0ab5709b"],
  af_alloy: ["B", "MM minutes", "C", "6d877149"],
  af_aoede: ["B", "H hours", "C+", "c03bd1a4"],
  af_bella: ["A", "HH hours", "A-", "8cb64e02"],
  af_jessica: ["C", "MM minutes", "D", "cdfdccb8"],
  af_kore: ["B", "H hours", "C+", "8bfbc512"],
  af_nicole: ["B", "HH hours", "B-", "c5561808"],
  af_nova: ["B", "MM minutes", "C", "e0233676"],
  af_river: ["C", "MM minutes", "D", "e149459b"],
  af_sarah: ["B", "H hours", "C+", "49bd364e"],
  af_sky: ["B", "M minutes", "C-", "c799548a"],
  am_adam: ["D", "H hours", "F+", "ced7e284"],
  am_echo: ["C", "MM minutes", "D", "8bcfdc85"],
  am_eric: ["C", "MM minutes", "D", "ada66f0e"],
  am_fenrir: ["B", "H hours", "C+", "98e507ec"],
  am_liam: ["C", "MM minutes", "D", "c8255075"],
  am_michael: ["B", "H hours", "C+", "9a443b79"],
  am_onyx: ["C", "MM minutes", "D", "e8452be1"],
  am_puck: ["B", "H hours", "C+", "dd1d8973"],
  am_santa: ["C", "M minutes", "D-", "7f2f7582"],
  bf_alice: ["C", "MM minutes", "D", "d292651b"],
  bf_emma: ["B", "HH hours", "B-", "d0a423de"],
  bf_isabella: ["B", "MM minutes", "C", "cdd4c370"],
  bf_lily: ["C", "MM minutes", "D", "6e09c2e4"],
  bm_daniel: ["C", "MM minutes", "D", "fc3fce4e"],
  bm_fable: ["B", "MM minutes", "C", "d44935f3"],
  bm_george: ["B", "MM minutes", "C", "f1bc8122"],
  bm_lewis: ["C", "H hours", "D+", "b5204750"],
};
const DURATION_KEY = "HH hours: 10 to 100 h; H hours: 1 to 10 h; MM minutes: 10 to 100 min; M minutes: 1 to 10 min";

// ---- the passages: verbatim paragraphs of the Repertory's own texts, by
// paragraph index, pinned by SHA-256 so a changed text fails the bench
// rather than silently changing what is measured.
const MALE_CANDIDATES = ["am_michael", "am_puck", "am_fenrir", "bm_george"];
const DISTANCE_VOICES = ["af_heart", ...MALE_CANDIDATES];
const PASSAGES = {
  // The Cave's longest narration paragraph ("And now look again...").
  narration: { work: "cave", paragraphs: [14, 14], sha256: "da81c003c94da961ed084ebd0a0f344139ae88cbc4b07a7e19c9483fd96049de" },
  // One Crito turn with its speaker label ("CRITO:  I should not have liked myself..."); the label is not spoken.
  dialogue: { work: "crito", paragraphs: [9, 9], sha256: "24bc4c690f23b7fd3cdb4c849f537245fb2af67a0be200534020c9d5593ad566" },
  // Audition clip: the Cave's opening paragraph, what a listener hears first.
  audition: { work: "cave", paragraphs: [0, 0], sha256: "465d6757c620284c153fe4488e3c7da8acae22f90ab5c8efbdfd5eb9780d821f" },
  // Holding over distance: the Cave from its opening through paragraph 14, about 3 minutes.
  distance: { work: "cave", paragraphs: [0, 14], sha256: "9fe96c653180111f809b232a7958e83efcf2df2ba7abb67d1ba97a93e55556d4" },
};

function passageText({ work, paragraphs: [from, to] }) {
  const text = readFileSync(path.join(repoRoot, "web", "public", "works", `${work}.txt`), "utf8");
  // Paragraph starts: the text's own blank-line breaks; the slice is verbatim.
  const starts = [0];
  for (const m of text.matchAll(/\n[ \t]*\n+/g)) starts.push(m.index + m[0].length);
  const end = to + 1 < starts.length ? text.lastIndexOf("\n", starts[to + 1] - 1) : text.length;
  return text.slice(starts[from], end).replace(/\s+$/, "");
}

function args() {
  const a = process.argv.slice(2);
  const only = a.includes("--only") ? a[a.indexOf("--only") + 1].split(",") : null;
  return { only, fresh: a.includes("--fresh"), pinPassages: a.includes("--print-passage-pins") };
}

function englishVoices() {
  return readdirSync(voiceDir)
    .filter((f) => /^[ab][fm]_[a-z]+\.bin$/.test(f))
    .map((f) => f.slice(0, -4))
    .sort();
}

async function loadTts() {
  const cacheDir = path.join(repoRoot, ".cache", "kokoro");
  for (const [file, pin] of Object.entries(MODEL_FILES)) {
    const p = path.join(cacheDir, REVISION, file);
    if (!existsSync(p)) throw new Error(`voice-bench: ${file} is not staged; run node scripts/fetch-voice.mjs first`);
    if (sha256(readFileSync(p)) !== pin) throw new Error(`voice-bench: ${file} does not match its pin in fetch-voice.mjs`);
  }
  const { env, StyleTextToSpeech2Model, AutoTokenizer } = await import("@huggingface/transformers");
  const { KokoroTTS } = await import("kokoro-js");
  env.allowRemoteModels = false;
  env.localModelPath = cacheDir;
  const model = await StyleTextToSpeech2Model.from_pretrained(REVISION, {
    dtype: "q8",
    device: "cpu",
    session_options: { intraOpNumThreads: THREADS, interOpNumThreads: 1 },
  });
  const tokenizer = await AutoTokenizer.from_pretrained(REVISION);
  return new KokoroTTS(model, tokenizer);
}

/** Renders each cue of `text` in `voice` at speed 1.0, as the tab does. Same text, same voice: rendered once. */
function makeRenderer(tts) {
  const memo = new Map();
  let audioSeconds = 0;
  let renderSeconds = 0;
  async function renderCue(voice, spoken) {
    const key = `${voice}\u0000${spoken}`;
    if (!memo.has(key)) {
      const t0 = performance.now();
      const raw = await tts.generate(spoken, { voice, speed: 1 });
      renderSeconds += (performance.now() - t0) / 1000;
      audioSeconds += raw.audio.length / raw.sampling_rate;
      if (raw.sampling_rate !== SR) throw new Error(`voice-bench: sample rate ${raw.sampling_rate}`);
      memo.set(key, new Float32Array(raw.audio));
    }
    return memo.get(key);
  }
  async function render(voice, text) {
    const cues = segment(text);
    const out = [];
    for (const c of cues) out.push({ ...c, words: M.countWords(c.spoken), audio: await renderCue(voice, c.spoken) });
    return out;
  }
  return { render, clear: () => memo.clear(), stats: () => ({ audioSeconds, renderSeconds }) };
}

function trimmed(cue) {
  const { start, end } = M.trimSilence(cue.audio, SR);
  return cue.audio.subarray(start, end);
}
function joinSpeech(cues) {
  const parts = cues.map(trimmed);
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Seconds as the tab plays a passage: every cue as rendered, then its pause from the fixed table, none after the last. */
function playedSeconds(cues) {
  return cues.reduce((s, c, i) => s + c.audio.length / SR + (i === cues.length - 1 ? 0 : c.pauseAfterMs / 1000), 0);
}

/** The measured row for passages (each a list of cues). */
function measure(...passages) {
  const cues = passages.flat();
  const speech = joinSpeech(cues);
  const words = cues.reduce((n, c) => n + c.words, 0);
  const played = passages.reduce((s, p) => s + playedSeconds(p), 0);
  return {
    words,
    speech_seconds: r1(speech.length / SR),
    wpm: r1(M.naturalWpm(cues, SR)),
    wpm_as_played: r1((words / played) * 60),
    median_f0_hz: r1(M.medianF0(speech, SR) ?? 0),
    spectral_centroid_hz: Math.round(M.spectralCentroid(speech, SR) ?? 0),
    loudness_dbfs: r1(M.activeDbfs(speech, SR)),
    pause_to_speech: r3(M.pauseRatio(speech, SR)),
  };
}

/** First and last 30 s of speech (whole cues, trimmed) of a long render. */
function distance(cues) {
  const window = (list) => {
    const picked = [];
    let s = 0;
    for (const c of list) {
      if (s >= 30) break;
      picked.push(c);
      s += M.voicedSeconds(c.audio, SR);
    }
    return picked;
  };
  const first = measure(window(cues));
  const last = measure(window([...cues].reverse()).reverse());
  const all = measure(cues);
  return {
    speech_seconds: all.speech_seconds,
    seconds_as_played: r1(playedSeconds(cues)),
    words: all.words,
    wpm: all.wpm,
    wpm_as_played: all.wpm_as_played,
    wpm_first_30s: first.wpm,
    wpm_last_30s: last.wpm,
    wpm_drift: r1(last.wpm - first.wpm),
    f0_first_30s_hz: first.median_f0_hz,
    f0_last_30s_hz: last.median_f0_hz,
    f0_drift_hz: r1(last.median_f0_hz - first.median_f0_hz),
  };
}

function writeWav(file, cues) {
  // As the tab plays it: each cue as rendered, then its pause from the fixed table; no pause after the last.
  const chunks = cues.map((c, i) => ({ audio: c.audio, pauseAfterMs: i === cues.length - 1 ? 0 : c.pauseAfterMs }));
  const samples = assemble(chunks, SR);
  writeFileSync(file, encodeWav(samples, SR));
  return samples.length / SR;
}

function ffmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", shell: false });
  return r.status === 0;
}

async function main() {
  const { only, fresh, pinPassages } = args();
  const texts = Object.fromEntries(Object.entries(PASSAGES).map(([k, p]) => [k, passageText(p)]));
  const pins = Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, sha256(t)]));
  if (pinPassages) {
    for (const [k, t] of Object.entries(texts)) console.log(k, pins[k], M.countWords(t), JSON.stringify(t.slice(0, 60)), "...", JSON.stringify(t.slice(-40)));
    return;
  }
  for (const [k, p] of Object.entries(PASSAGES)) {
    if (pins[k] !== p.sha256) throw new Error(`voice-bench: passage ${k} sha256 ${pins[k]}, pinned ${p.sha256}`);
  }

  mkdirSync(outDir, { recursive: true });
  const partial = !fresh && existsSync(partialFile) ? JSON.parse(readFileSync(partialFile, "utf8")) : {};
  const voices = englishVoices().filter((v) => !only || only.includes(v));
  const unknown = voices.filter((v) => !HEXGRAD[v]);
  if (unknown.length) throw new Error(`voice-bench: no hexgrad row for ${unknown.join(", ")}`);

  const tts = await loadTts();
  const r = makeRenderer(tts);
  const hasFfmpeg = ffmpeg();
  const auditions = [];
  for (const id of voices) {
    const needDistance = DISTANCE_VOICES.includes(id);
    if (partial[id] && (!needDistance || partial[id].distance)) {
      console.log(`voice-bench: ${id} (kept from partial.json)`);
      continue;
    }
    const t0 = performance.now();
    const before = r.stats();
    const narration = await r.render(id, texts.narration);
    const dialogue = await r.render(id, texts.dialogue);
    const row = measure(narration, dialogue);
    row.wpm_narration = measure(narration).wpm;
    row.wpm_dialogue = measure(dialogue).wpm;
    if (needDistance) {
      const long = await r.render(id, texts.distance);
      row.distance = distance(long);
    }
    const after = r.stats();
    row.render_rtf = r3((after.renderSeconds - before.renderSeconds) / Math.max(1e-9, after.audioSeconds - before.audioSeconds));
    partial[id] = row;
    writeFileSync(partialFile, JSON.stringify(partial, null, 1));
    console.log(`voice-bench: ${id} ${row.wpm} wpm, F0 ${row.median_f0_hz} Hz, centroid ${row.spectral_centroid_hz} Hz, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    r.clear();
  }

  // Audition clips: the narrator candidates and af_heart, the Cave's opening.
  for (const id of DISTANCE_VOICES.filter((v) => voices.includes(v))) {
    const cues = await r.render(id, texts.audition);
    const wav = path.join(outDir, `audition-${id}.wav`);
    const seconds = writeWav(wav, cues);
    let compressed = null;
    if (hasFfmpeg) {
      const opus = wav.replace(/\.wav$/, ".opus");
      const f = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", "-b:a", "48k", opus], { stdio: "inherit" });
      if (f.status === 0) compressed = path.basename(opus);
    }
    const m = measure(cues);
    auditions.push({
      voice: id,
      role: id === "af_heart" ? "female narrator (fixed)" : "male narrator candidate",
      wav: path.basename(wav),
      compressed,
      seconds_as_played: r1(seconds),
      words: m.words,
      wpm_as_played: r1((m.words / seconds) * 60),
      wpm: m.wpm,
      median_f0_hz: m.median_f0_hz,
      spectral_centroid_hz: m.spectral_centroid_hz,
      loudness_dbfs: m.loudness_dbfs,
      pause_to_speech: m.pause_to_speech,
      hexgrad_grade: HEXGRAD[id][2],
      distance: partial[id]?.distance ?? null,
    });
    r.clear();
  }

  const engine = {
    model: `${REPO}@${REVISION}`,
    model_sha256: MODEL_FILES["onnx/model_quantized.onnx"],
    dtype: "q8",
    runtime: `onnxruntime-node ${pkgVersion("onnxruntime-node")} (CPU, ${THREADS} threads)`,
    "kokoro-js": pkgVersion("kokoro-js"),
    "@huggingface/transformers": pkgVersion("@huggingface/transformers"),
    speed: 1.0,
    sample_rate: SR,
  };
  if (auditions.length) {
    writeFileSync(
      path.join(outDir, "audition.json"),
      JSON.stringify({ date: today(), passage: { ...PASSAGES.audition, sha256: pins.audition, words: M.countWords(texts.audition) }, engine, ffmpeg: hasFfmpeg, clips: auditions }, null, 2) + "\n",
    );
  }

  const all = englishVoices();
  if (only || all.some((v) => !partial[v])) {
    console.log(`voice-bench: ${Object.keys(partial).length} of ${all.length} voices measured; design/voices.json is written only when all are`);
    return;
  }
  const table = {
    provenance: {
      measured_source_data:
        "Measured source data, read by casting (T2c). Not a build artifact: it is written by scripts/voice-bench.mjs on a developer machine, reviewed, and committed; no build step regenerates it.",
      date: today(),
      engine,
      method: {
        summary: "Each voice renders the same passages cue by cue at speed 1.0, exactly as the tab does; numbers are measured on the rendered samples by scripts/lib/voice-measure.mjs.",
        wpm: "articulation rate: words (whitespace and dashes separate; a token needs a letter or digit) over speaking seconds, each cue trimmed of its leading and trailing silence (a 20 ms frame is silent below the loudest frame -40 dB, or -60 dBFS). Pauses inside a cue count; the tab's pause table between cues does not. Only same-passage numbers compare.",
        wpm_as_played: "the same words over the seconds a listener hears in Dial: each cue as Kokoro renders it (its own leading and trailing silence included) plus the tab's fixed pause table between cues (web/src/engine/segment.ts PAUSE_MS), none after a passage's last cue. This is the number to hold against a presenter's 150 to 165 wpm; wpm above is the voice's articulation rate.",
        median_f0_hz: "normalized autocorrelation on the signal decimated to 8 kHz, 40 ms windows every 10 ms, 60 to 400 Hz, voiced when not silent and the best peak is >= 0.5; shortest-lag peak within 90 % of the best, parabolic refinement; median over voiced windows.",
        spectral_centroid_hz: "1024-point Hann FFT every 512 samples; magnitude-weighted mean frequency per non-silent frame, averaged.",
        loudness_dbfs: "RMS over non-silent frames of the trimmed speech (an active-speech level, not LUFS).",
        pause_to_speech: "inside the trimmed cues, silent runs of at least 150 ms over the remaining time.",
        distance:
          "af_heart and the four male narrator candidates only: the Cave's paragraphs 0 to 14 rendered as one run, cue by cue (about 3 minutes as played); first and last 30 s of speech (whole cues). Kokoro renders each cue independently, so drift here reflects the text more than the voice. The 10-minute render was skipped for time.",
        hexgrad: `grade, target quality and training duration are copied from hexgrad's table and describe training data, not naturalness. Duration: ${DURATION_KEY}.`,
      },
      passages: Object.fromEntries(Object.entries(PASSAGES).map(([k, p]) => [k, { work: p.work, paragraphs: p.paragraphs, sha256: pins[k], words_in_text: M.countWords(texts[k]), words_spoken: segment(texts[k]).reduce((n, c) => n + M.countWords(c.spoken), 0) }])),
      hexgrad_table: HEXGRAD_TABLE,
    },
    voices: all.map((id) => {
      const [target, duration, grade, ptPrefix] = HEXGRAD[id];
      const p = partial[id];
      return {
        id,
        sex: id[1],
        accent: id[0] === "a" ? "us" : "uk",
        hexgrad: { grade, target_quality: target, training_duration: duration, pt_sha256_prefix: ptPrefix },
        file_sha256: sha256(readFileSync(path.join(voiceDir, `${id}.bin`))),
        wpm: p.wpm,
        wpm_as_played: p.wpm_as_played,
        wpm_narration: p.wpm_narration,
        wpm_dialogue: p.wpm_dialogue,
        median_f0_hz: p.median_f0_hz,
        spectral_centroid_hz: p.spectral_centroid_hz,
        loudness_dbfs: p.loudness_dbfs,
        pause_to_speech: p.pause_to_speech,
        render_rtf: p.render_rtf,
        ...(p.distance ? { distance: p.distance } : {}),
      };
    }),
  };
  writeFileSync(path.join(repoRoot, "design", "voices.json"), stringify(table) + "\n");
  console.log(`voice-bench: wrote design/voices.json (${all.length} voices)`);
}

function pkgVersion(name) {
  return JSON.parse(readFileSync(path.join(repoRoot, "node_modules", name, "package.json"), "utf8")).version;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
/** Pretty JSON with each voice on one line, so the table reads as a table and diffs by voice. */
function stringify(table) {
  const head = JSON.stringify({ provenance: table.provenance }, null, 2).replace(/\n}$/, "");
  return `${head},\n  "voices": [\n${table.voices.map((v) => "    " + JSON.stringify(v)).join(",\n")}\n  ]\n}`;
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
