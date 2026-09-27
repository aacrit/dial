#!/usr/bin/env node
// Stages the voice into web/public/ so the page never fetches it from
// another origin (Law 1: the only outbound bytes are this site's own).
//
// - Kokoro-82M (q8 ONNX) and its tokenizer, from Hugging Face at a pinned
//   revision, downloaded once into .cache/ and checked against SHA-256 pins.
//   The model is split into parts under 20 MiB, because Workers Static
//   Assets serves at most 25 MiB per file; web/src/voice.ts stitches them.
// - The voice files the catalogue's casts use (web/src/engine/cast.ts), from
//   the kokoro-js package.
// - onnxruntime-web's WASM runtime, from its package.
//
// None of these are tracked in git (rule 8): web/public/voice and
// web/public/ort are gitignored, and this runs before every build and dev.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./lib/walk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(repoRoot, ".cache", "kokoro");
const voiceOut = path.join(repoRoot, "web", "public", "voice");
const ortOut = path.join(repoRoot, "web", "public", "ort");

export const REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const PART_BYTES = 20 * 1024 * 1024;

// SHA-256 of every staged file. A changed upstream byte fails the build.
export const MODEL_FILES = {
  "config.json": "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
  "tokenizer.json": "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
  "tokenizer_config.json": "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
  "onnx/model_quantized.onnx": "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
};
// The same model at full precision, for the graphics chip only (T7,
// web/src/speed/backend.ts): the q8 model runs on WebGPU but its quantized
// operators fall back to the processor, so it is slower there than on the
// processor alone; fp16 speaks wrongly on WebGPU. It is staged and pinned
// like the rest, in its own parts, and downloaded only when a listener
// chooses to test the graphics chip, with its size said first
// (manifest.gpu.bytes). It is never part of Save for offline or the voice's
// "about 115 MB".
export const GPU_MODEL = { file: "onnx/model.onnx", sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb" };
// The voice files, each pinned: the two narrators (web/src/engine/cast.ts
// NARRATORS, male then female), then every character voice the catalogue's
// casts use, in order of first use. tests/speakers.test.ts recomputes the
// casts and keeps this list exactly equal to them, and checks each pin
// against design/voices.json's file_sha256. A voice no work uses is not
// staged: the pool is the whole table, the download is only what is cast.
// The pins also go into manifest.json (voices), where the page checks each
// file on fetch and on every read from its cache.
export const VOICES = {
  am_michael: "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
  af_heart: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
  am_fenrir: "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43",
  am_puck: "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0",
};
// onnxruntime-web's runtime, pinned like the model: a changed byte fails the
// build. The .wasm's pin also goes into manifest.json (runtimeSha256), where
// the page keys its cached copy to it and checks it on every read.
export const ORT_WASM = "ort-wasm-simd-threaded.jsep.wasm";
export const ORT_FILES = {
  "ort-wasm-simd-threaded.jsep.mjs": "08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9",
  [ORT_WASM]: "c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39",
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Throws unless buf matches its SHA-256 pin. */
export function checkPin(file, buf, expected) {
  const got = sha256(buf);
  if (got !== expected) throw new Error(`fetch-voice: ${file} sha256 ${got}, pinned ${expected}`);
  return buf;
}

async function cached(file, expected) {
  const target = path.join(cacheDir, REVISION, file);
  if (existsSync(target) && sha256(readFileSync(target)) === expected) return readFileSync(target);
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`;
  console.log(`fetch-voice: downloading ${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch-voice: ${url} answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  checkPin(file, buf, expected);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, buf);
  return buf;
}

function resolvePackageDir(name) {
  // kokoro-js's dependency tree is hoisted by npm; look there first.
  const dir = path.join(repoRoot, "node_modules", name);
  if (!existsSync(dir)) throw new Error(`fetch-voice: ${name} is not installed (npm ci)`);
  return dir;
}

/**
 * The model's other files (tokenizer.json, tokenizer_config.json,
 * config.json), by the path they are served at, with their SHA-256 pins.
 * They go into manifest.json (files), where the page checks each on fetch
 * and on every read from its cache, as it does the model (T11, L4).
 */
export function modelFilePins() {
  return Object.fromEntries(
    Object.entries(MODEL_FILES)
      .filter(([file]) => !file.endsWith(".onnx"))
      .map(([file, pin]) => [`/voice/models/${REPO}/${file}`, pin]),
  );
}

/** Where the voice and the runtime are staged, for the build and the tests. */
export const STAGED_DIRS = { voice: voiceOut, ort: ortOut };

/**
 * Every staged file the tab may download, by the path it is served at
 * ("/voice/...", "/ort/..."), with its size in bytes (the manifest itself
 * excluded).
 */
export function stagedSizes() {
  const sizes = {};
  for (const [dir, prefix] of [[voiceOut, "/voice/"], [ortOut, "/ort/"]]) {
    for (const file of walk(dir)) {
      if (path.resolve(file) === path.join(voiceOut, "manifest.json")) continue;
      sizes[prefix + path.relative(dir, file).split(path.sep).join("/")] = statSync(file).size;
    }
  }
  return Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)));
}

/** Sum of every staged file the tab may download (the manifest itself excluded). */
export function stagedBytes() {
  return Object.values(stagedSizes()).reduce((a, b) => a + b, 0);
}

/**
 * Stages the voice and the runtime. The runtime is read and checked against
 * its pins before anything on disk changes, so a mismatch fails the build
 * and leaves the last good staging in place. `ortPins` exists for the tests.
 */
export async function stage({ ortPins = ORT_FILES } = {}) {
  const ortDist = path.join(resolvePackageDir("onnxruntime-web"), "dist");
  const ortBufs = Object.entries(ortPins).map(([f, pin]) => [f, checkPin(f, readFileSync(path.join(ortDist, f)), pin)]);

  rmSync(voiceOut, { recursive: true, force: true });
  const modelDir = path.join(voiceOut, "models", REPO);
  const parts = [];
  for (const [file, pin] of Object.entries(MODEL_FILES)) {
    const buf = await cached(file, pin);
    if (file.endsWith(".onnx")) {
      mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
      for (let i = 0, n = 0; i < buf.length; i += PART_BYTES, n++) {
        const name = `model_quantized.part${n}`;
        writeFileSync(path.join(modelDir, "onnx", name), buf.subarray(i, i + PART_BYTES));
        parts.push(name);
      }
    } else {
      mkdirSync(path.dirname(path.join(modelDir, file)), { recursive: true });
      writeFileSync(path.join(modelDir, file), buf);
    }
  }

  const gpuBuf = await cached(GPU_MODEL.file, GPU_MODEL.sha256);
  const gpuParts = [];
  for (let i = 0, n = 0; i < gpuBuf.length; i += PART_BYTES, n++) {
    const name = `model.part${n}`;
    writeFileSync(path.join(modelDir, "onnx", name), gpuBuf.subarray(i, i + PART_BYTES));
    gpuParts.push(name);
  }

  mkdirSync(path.join(voiceOut, "voices"), { recursive: true });
  for (const [id, pin] of Object.entries(VOICES)) {
    const buf = checkPin(`${id}.bin`, readFileSync(path.join(resolvePackageDir("kokoro-js"), "voices", `${id}.bin`)), pin);
    writeFileSync(path.join(voiceOut, "voices", `${id}.bin`), buf);
  }

  rmSync(ortOut, { recursive: true, force: true });
  mkdirSync(ortOut, { recursive: true });
  for (const [f, buf] of ortBufs) writeFileSync(path.join(ortOut, f), buf);

  // The manifest the page reads to stitch the model back together. It also
  // carries every staged file's size (sizes, by served path) and their sum
  // (totalBytes: everything staged). No visit downloads all of it: the page
  // sums only the files it still needs (web/src/voice-cache.ts neededBytes),
  // so its "about N MB" and its meter are computed, never guessed. A first
  // visit downloads the model, tokenizer and config, the runtime's .wasm and
  // .mjs, and the voices that work's cast uses (the Cave and the Meditations:
  // Michael; Crito: Fenrir and Puck); a later work adds only its new voices.
  const sizes = stagedSizes();
  const totalBytes = Object.values(sizes).reduce((a, b) => a + b, 0);
  writeFileSync(
    path.join(voiceOut, "manifest.json"),
    JSON.stringify(
      {
        repo: REPO,
        revision: REVISION,
        model: "onnx/model_quantized.onnx",
        sha256: MODEL_FILES["onnx/model_quantized.onnx"],
        parts,
        gpu: { model: GPU_MODEL.file, sha256: GPU_MODEL.sha256, parts: gpuParts, bytes: gpuBuf.length },
        files: modelFilePins(),
        voices: VOICES,
        runtime: ORT_WASM,
        runtimeSha256: ortPins[ORT_WASM],
        sizes,
        totalBytes,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`fetch-voice: staged Kokoro-82M q8 in ${parts.length} parts (fp32 for the graphics chip in ${gpuParts.length}), voices ${Object.keys(VOICES).join(", ")}, onnxruntime-web`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stage().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
