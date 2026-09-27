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
// samples) as drift. This is measured per part with ffmpeg's own decode as
// the reference, and the run fails if any part is outside that one-frame
// bound (recording/timing.ts withinDriftBound) -- the same bound
// recording/source.ts lineSlice already tolerates when the decoded audio
// is shorter or longer than expected by an encoder's frame.
//
// Writes <out>/<slug>/partN.m4a and <out>/<slug>/manifest.m4a.json (codec,
// bitrate, the measured encoder delay, and each part's bytes, sha256 and
// drift), and rewrites <out>/<slug>/index.json and manifest.json in place,
// adding each part's m4a pin so scripts/lib/recordings-lock.mjs lockFrom
// can pin both encodings from one release.
//
//   node scripts/transcode-m4a.mjs [--only cave,crito] [--out D:/dial-recordings]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogueSlugs, castEngineVersion } from "./fetch-recordings.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** AAC-LC's fixed frame size, at any sample rate: the bound a part's m4a decode may drift from its Opus decode (recording/timing.ts AAC_FRAME_SAMPLES; kept in step by tests/recordings.test.ts). */
export const AAC_FRAME_SAMPLES = 1024;
/** ffmpeg's native AAC encoder's own priming delay, measured once (see docs/DECISIONS.md T5b): one frame, trimmed back out by the MP4 edit list on decode. */
export const ENCODER_DELAY_SAMPLES = 1024;
// ffmpeg's native AAC encoder's actual output runs a few kb/s above its
// -b:a target at this rate; 60 kb/s requested measures about 63-64 kb/s
// encoded (about 64 kbps, CoS decision H), landing the m4a set at about
// 1.3x the Opus set's bytes rather than closer to 1.45x at a 64 kb/s target.
export const AAC_BITRATE = 60000;

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

const pcmSamples = (file) => readFileSync(file).length / 4;

/** Where part i's samples start and end in the index's work time, in samples. */
function partSampleSpan(index, i) {
  const part = index.parts[i];
  const start = index.lines[part.from].at;
  const end = part.to < index.lines.length ? index.lines[part.to].at : index.samples;
  return end - start;
}

/** Transcodes one work's parts: writes partN.m4a, returns { parts, worstDriftSamples }. Throws if any part's drift is outside the bound. */
function transcodeWork(slug, dir, index) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `dial-m4a-${slug}-`));
  const parts = [];
  let worstDrift = 0;
  try {
    index.parts.forEach((part, i) => {
      const opusFile = path.join(dir, part.file);
      const opusPcm = path.join(scratch, `${i}.opus.pcm`);
      decodeToPcm(opusFile, index.sampleRate, opusPcm);
      const opusSamples = pcmSamples(opusPcm);
      const expected = partSampleSpan(index, i);
      if (opusSamples !== expected) throw new Error(`transcode-m4a: ${slug} part ${i}: the Opus master decoded to ${opusSamples} samples, the index expects ${expected}`);

      const m4aFile = path.join(dir, `part${i}.m4a`);
      encodeAac(opusPcm, index.sampleRate, m4aFile);

      const roundtripPcm = path.join(scratch, `${i}.m4a.pcm`);
      decodeToPcm(m4aFile, index.sampleRate, roundtripPcm);
      const m4aSamples = pcmSamples(roundtripPcm);
      const drift = m4aSamples - opusSamples;
      if (Math.abs(drift) > AAC_FRAME_SAMPLES) throw new Error(`transcode-m4a: ${slug} part ${i}: m4a decoded to ${m4aSamples} samples, Opus ${opusSamples} (drift ${drift}, over the ${AAC_FRAME_SAMPLES}-sample bound)`);
      worstDrift = Math.abs(drift) > Math.abs(worstDrift) ? drift : worstDrift;

      const buf = readFileSync(m4aFile);
      if (buf.length >= 20 * 1024 * 1024) throw new Error(`transcode-m4a: ${slug} part${i}.m4a is over 20 MiB`);
      parts.push({ file: `part${i}.m4a`, bytes: buf.length, sha256: sha256(buf), seconds: part.seconds });
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { parts, worstDriftSamples: worstDrift };
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
    const { parts, worstDriftSamples } = transcodeWork(slug, dir, index);

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
      parts,
      total_bytes: m4aBytes,
    };
    writeFileSync(path.join(dir, "manifest.m4a.json"), JSON.stringify(m4aManifest, null, 1) + "\n");
    console.log(`transcode-m4a: ${slug}: opus ${(opusBytes / 1e6).toFixed(2)} MB, m4a ${(m4aBytes / 1e6).toFixed(2)} MB (${(m4aBytes / opusBytes).toFixed(2)}x), worst drift ${worstDriftSamples} samples`);
  }
  if (totals.opus) console.log(`transcode-m4a: totals: opus ${(totals.opus / 1e6).toFixed(2)} MB, m4a ${(totals.m4a / 1e6).toFixed(2)} MB (${(totals.m4a / totals.opus).toFixed(2)}x)`);
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
