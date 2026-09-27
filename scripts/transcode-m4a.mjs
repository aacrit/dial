#!/usr/bin/env node
// T5b: makes each recorded work's AAC-LC .m4a encoding of the SAME masters
// scripts/render-recordings.mjs made (Opus 48 kbps mono in WebM), for a
// browser that cannot reliably decode Opus in WebM (iPhone and desktop
// Safari). Never renders with TTS again: each part's Opus master is
// decoded to PCM with ffmpeg-static and that PCM is re-encoded to AAC-LC,
// mono, 24 kHz, about 64 kbps, in an .m4a (MP4) container (CoS decision H).
//
// Same part boundaries and durations as the Opus set: the timing index
// stays one file, shared by both encodings (recording/timing.ts
// RecordingPart.m4a). ffmpeg's AAC encoder has a fixed one-frame (1024
// sample) priming delay; muxed into MP4 it writes an edit list that trims
// that delay back out on decode, so decoding a finished .m4a part (through
// its container, as the browser will) lands its first real sample where
// the Opus part's did, leaving only the last frame's padding (up to 1024
// samples) as drift. Two checks, both against ffmpeg's own decode as the
// reference (a real browser cannot be driven from here):
//   - total length, per part, against the drift bound (recording/timing.ts
//     withinDriftBound). This alone cannot tell a leading offset from
//     trailing padding: a decoder that kept the encoder's priming delay
//     AND happened to trim the same amount elsewhere would still pass it.
//   - start alignment: the first ~100 ms of the Opus PCM cross-correlated
//     against the m4a PCM, which must best align at (nearly) zero lag. A
//     decoder that ignored the edit list would show this at
//     ENCODER_DELAY_SAMPLES instead. Bound: a handful of samples, not a
//     whole frame, since this checks position, not the drift a padded or
//     trimmed frame is expected to add.
// The run fails past either bound. As a second line of defense, since a
// review found no way to prove every real browser respects the edit list,
// recording/source.ts Recording.part() also drops a decode's leading
// excess itself, at runtime, whenever it is at least one AAC frame.
//
// No iTunSMPB gapless atom is written: ffmpeg's mov/mp4 muxer has no option
// for it (checked: `ffmpeg -h muxer=mov` lists no gapless or iTunSMPB flag,
// and a plain encode carries no such atom), and writing Apple's undocumented
// binary format by hand is not cheap or safe to add here. The MP4 edit list
// ffmpeg does write, verified above and separately measured at 0 samples of
// drift in Chromium's own decodeAudioData, is the mechanism relied on.
//
// Writes <out>/<slug>/partN.m4a and <out>/<slug>/manifest.m4a.json (codec,
// bitrate, the measured encoder delay, and each part's bytes, sha256,
// drift and start-alignment lag), and rewrites <out>/<slug>/index.json and
// manifest.json in place, adding each part's m4a pin so
// scripts/lib/recordings-lock.mjs lockFrom can pin both encodings from one
// release.
//
//   node scripts/transcode-m4a.mjs [--only cave,crito] [--out D:/dial-recordings]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogueSlugs, castEngineVersion } from "./fetch-recordings.mjs";

// This file's own TypeScript import (timing.ts) needs the type-stripping
// transform, as render-recordings.mjs re-execs itself for the same reason.
if (!process.execArgv.includes("--experimental-transform-types")) {
  const r = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { AAC_FRAME_SAMPLES, partSpanSamples, withinDriftBound } = await import(pathToFileURL(path.join(repoRoot, "web", "src", "recording", "timing.ts")).href);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** ffmpeg's native AAC encoder's own priming delay, measured once (see docs/DECISIONS.md T5b): one frame, trimmed back out by the MP4 edit list on decode. */
export const ENCODER_DELAY_SAMPLES = AAC_FRAME_SAMPLES;
// ffmpeg's native AAC encoder's actual output runs a few kb/s above its
// -b:a target at this rate; 60 kb/s requested measures about 63-64 kb/s
// encoded (about 64 kbps, CoS decision H), landing the m4a set at about
// 1.3x the Opus set's bytes rather than closer to 1.45x at a 64 kb/s target.
export const AAC_BITRATE = 60000;

/** The reference window for the start-alignment check: 100 ms at 24 kHz. */
const ALIGN_WINDOW_SAMPLES = 2400;
/** How far either side of zero lag is searched: past ENCODER_DELAY_SAMPLES, with margin. */
const ALIGN_SEARCH_SAMPLES = 1536;
/** The start-alignment bound: a handful of samples, not a whole frame (a whole frame is the total-length bound, withinDriftBound). */
export const START_ALIGNMENT_BOUND_SAMPLES = 8;
/** Below this RMS, the reference window is judged too quiet to trust a correlation lag from (a rare part that opens in silence); logged, not failed. */
const ALIGN_MIN_RMS = 0.01;

function args() {
  const a = process.argv.slice(2);
  const val = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  return { only: val("--only")?.split(","), out: path.resolve(val("--out", "D:/dial-recordings")) };
}

function ffmpegPath() {
  // An optional dependency, as render-recordings.mjs's ffmpegPath(): the gate never needs it.
  let bin;
  try {
    bin = createRequire(import.meta.url)("ffmpeg-static");
  } catch {
    bin = null;
  }
  if (!bin || !existsSync(bin)) throw new Error("transcode-m4a: ffmpeg-static is not installed. Run npm install --include=optional (its postinstall downloads the ffmpeg binary), then transcode again.");
  return bin;
}

function ffmpeg(cmdArgs) {
  const r = spawnSync(ffmpegPath(), cmdArgs, { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) throw new Error(`transcode-m4a: ffmpeg exited ${r.status}: ${(r.stderr ?? Buffer.alloc(0)).toString("utf8").slice(-4000)}`);
}

/** Decodes an Opus/WebM or AAC/m4a part to raw mono Float32 PCM at `rate`, through its container (so an m4a's edit list applies, as a browser's decoder would honor it). */
function decodeToPcm(file, rate, pcmFile) {
  ffmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-f", "f32le", "-ar", String(rate), "-ac", "1", pcmFile]);
}

/** Encodes raw Float32 mono PCM at `rate` to AAC-LC in an .m4a (MP4) container, byte for byte the same for the same samples. */
function encodeAac(pcmFile, rate, m4aFile) {
  ffmpeg([
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "f32le", "-ar", String(rate), "-ac", "1", "-i", pcmFile,
    "-c:a", "aac", "-b:a", String(AAC_BITRATE), "-ar", String(rate),
    "-map_metadata", "-1", "-movflags", "+faststart",
    "-f", "mp4", m4aFile,
  ]);
}

/** A raw f32le PCM file's samples, as a view (no copy). */
function readPcm(file) {
  const buf = readFileSync(file);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/** RMS of a window (for judging whether it carries enough signal to trust a correlation). */
function rms(a) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / Math.max(1, a.length));
}

/** How far into a part scan for real speech: a line often opens with the TTS's own lead-in silence (measured: up to about 400 ms), which carries no signal to align on. */
const ONSET_STEP_SAMPLES = 480; // 20 ms
const ONSET_SCAN_SECONDS = 5;

/** The first sample offset (a multiple of ONSET_STEP_SAMPLES) whose next step has RMS at or above ALIGN_MIN_RMS; null if none in the first ONSET_SCAN_SECONDS. */
function findOnset(a, maxScan) {
  const limit = Math.min(maxScan, a.length) - ONSET_STEP_SAMPLES;
  for (let start = 0; start <= limit; start += ONSET_STEP_SAMPLES) {
    if (rms(a.subarray(start, start + ONSET_STEP_SAMPLES)) >= ALIGN_MIN_RMS) return start;
  }
  return null;
}

/**
 * The lag (samples) at which `b` best matches `a`'s window [refStart, refStart+windowLen),
 * by least squared error, searched over [-maxLag, +maxLag]. 0 means aligned; ENCODER_DELAY_SAMPLES
 * means b carries the encoder's undropped priming delay (the edit list was not honoured by
 * whatever decoded it). The window sits later in the part, not at its very first sample, since a
 * line often opens with silence (findOnset); the lag it measures is the same either way, since a
 * misaligned decode is offset by a constant amount for the whole part, not just its start.
 */
function bestLag(a, b, refStart, windowLen, maxLag) {
  let best = { lag: 0, score: Infinity };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < windowLen; i++) {
      const ai = refStart + i;
      const bi = refStart + i + lag;
      if (ai < 0 || ai >= a.length || bi < 0 || bi >= b.length) continue;
      const d = a[ai] - b[bi];
      sum += d * d;
      n++;
    }
    if (n < windowLen * 0.5) continue;
    const score = sum / n;
    if (score < best.score) best = { lag, score };
  }
  return best.lag;
}

/** Transcodes one work's parts: writes partN.m4a, returns { parts, worstDriftSamples, worstAlignSamples }. Throws if any part is outside either bound. */
function transcodeWork(slug, dir, index) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `dial-m4a-${slug}-`));
  const parts = [];
  let worstDrift = 0;
  let worstAlign = 0;
  try {
    index.parts.forEach((part, i) => {
      const opusFile = path.join(dir, part.file);
      const opusPcm = path.join(scratch, `${i}.opus.pcm`);
      decodeToPcm(opusFile, index.sampleRate, opusPcm);
      const opusWindow = readPcm(opusPcm);
      const opusSamples = opusWindow.length;
      const expected = partSpanSamples(index, i);
      if (opusSamples !== expected) throw new Error(`transcode-m4a: ${slug} part ${i}: the Opus master decoded to ${opusSamples} samples, the index expects ${expected}`);

      const m4aFile = path.join(dir, `part${i}.m4a`);
      encodeAac(opusPcm, index.sampleRate, m4aFile);

      const roundtripPcm = path.join(scratch, `${i}.m4a.pcm`);
      decodeToPcm(m4aFile, index.sampleRate, roundtripPcm);
      const m4aWindow = readPcm(roundtripPcm);
      const m4aSamples = m4aWindow.length;
      const drift = m4aSamples - opusSamples;
      if (!withinDriftBound(drift)) throw new Error(`transcode-m4a: ${slug} part ${i}: m4a decoded to ${m4aSamples} samples, Opus ${opusSamples} (drift ${drift}, outside withinDriftBound)`);
      worstDrift = Math.abs(drift) > Math.abs(worstDrift) ? drift : worstDrift;

      // Start alignment: does the m4a decode's real content begin at the same sample as the Opus decode's?
      // The total-length check alone cannot tell this from trailing padding (a decode that kept the encoder's
      // priming delay could still land within the drift bound if it were also trimmed elsewhere).
      let lag = 0;
      const onset = findOnset(opusWindow, Math.min(opusSamples, ONSET_SCAN_SECONDS * index.sampleRate));
      if (onset === null || onset < ALIGN_SEARCH_SAMPLES) {
        console.warn(`transcode-m4a: ${slug} part ${i}: no window with enough signal (and enough room before it) in the first ${ONSET_SCAN_SECONDS} s to trust a start-alignment lag from; skipped (the total-length check above still applies)`);
      } else {
        lag = bestLag(opusWindow, m4aWindow, onset, Math.min(ALIGN_WINDOW_SAMPLES, opusSamples - onset), ALIGN_SEARCH_SAMPLES);
        if (Math.abs(lag) > START_ALIGNMENT_BOUND_SAMPLES) throw new Error(`transcode-m4a: ${slug} part ${i}: m4a's start is ${lag} samples off the Opus master's (bound ${START_ALIGNMENT_BOUND_SAMPLES}); the edit list may not have been honoured on decode`);
        worstAlign = Math.abs(lag) > Math.abs(worstAlign) ? lag : worstAlign;
      }

      const buf = readFileSync(m4aFile);
      if (buf.length >= 20 * 1024 * 1024) throw new Error(`transcode-m4a: ${slug} part${i}.m4a is over 20 MiB`);
      parts.push({ file: `part${i}.m4a`, bytes: buf.length, sha256: sha256(buf), seconds: part.seconds, driftSamples: drift, alignSamples: lag });
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { parts, worstDriftSamples: worstDrift, worstAlignSamples: worstAlign };
}

async function main() {
  const a = args();
  const slugs = (a.only ?? catalogueSlugs()).filter((s) => existsSync(path.join(a.out, s, "manifest.json")));
  const castVersion = castEngineVersion();
  const totals = { opus: 0, m4a: 0 };
  for (const slug of slugs) {
    const dir = path.join(a.out, slug);
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
    if (manifest.engine.cast !== castVersion) throw new Error(`transcode-m4a: ${slug} was cast with engine ${manifest.engine.cast}, this build casts with ${castVersion}: render it again first`);
    const index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));

    console.log(`transcode-m4a: ${slug}: ${index.parts.length} parts`);
    const { parts, worstDriftSamples, worstAlignSamples } = transcodeWork(slug, dir, index);

    // The index stays one file, shared by both encodings: each part's m4a pin joins its Opus pin. RECORDING_FORMAT bumped to 2 for the added shape.
    index.format = 2;
    index.parts.forEach((part, i) => {
      part.m4a = { file: parts[i].file, bytes: parts[i].bytes, sha256: parts[i].sha256 };
    });
    const indexText = JSON.stringify(index) + "\n";
    writeFileSync(path.join(dir, "index.json"), indexText);

    // manifest.json's own index pin must match the index it now describes; its opus parts are untouched.
    manifest.index = { file: "index.json", bytes: Buffer.byteLength(indexText), sha256: sha256(indexText) };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");

    const m4aBytes = parts.reduce((n, p) => n + p.bytes, 0);
    const opusBytes = manifest.total_bytes;
    totals.opus += opusBytes;
    totals.m4a += m4aBytes;
    const m4aManifest = {
      slug,
      made: manifest.made,
      codec: "aac-lc/m4a",
      bitrate: AAC_BITRATE,
      encoderDelaySamples: ENCODER_DELAY_SAMPLES,
      worstDriftSamples,
      driftBoundSamples: AAC_FRAME_SAMPLES,
      worstAlignSamples,
      alignBoundSamples: START_ALIGNMENT_BOUND_SAMPLES,
      parts,
      total_bytes: m4aBytes,
    };
    writeFileSync(path.join(dir, "manifest.m4a.json"), JSON.stringify(m4aManifest, null, 1) + "\n");
    console.log(
      `transcode-m4a: ${slug}: opus ${(opusBytes / 1e6).toFixed(2)} MB, m4a ${(m4aBytes / 1e6).toFixed(2)} MB (${(m4aBytes / opusBytes).toFixed(2)}x), worst drift ${worstDriftSamples} samples, worst start-alignment ${worstAlignSamples} samples`,
    );
  }
  if (totals.opus) console.log(`transcode-m4a: totals: opus ${(totals.opus / 1e6).toFixed(2)} MB, m4a ${(totals.m4a / 1e6).toFixed(2)} MB (${(totals.m4a / totals.opus).toFixed(2)}x)`);
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
