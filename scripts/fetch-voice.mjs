#!/usr/bin/env node
// Stages the voice into web/public/ so the page never fetches it from
// another origin (Law 1: the only outbound bytes are this site's own).
//
// - Kokoro-82M (q8 ONNX) and its tokenizer, from Hugging Face at a pinned
//   revision, downloaded once into .cache/ and checked against SHA-256 pins.
//   The model is split into parts under 20 MiB, because Workers Static
//   Assets serves at most 25 MiB per file; web/src/voice.ts stitches them.
// - The narrator's voice file, from the kokoro-js package.
// - onnxruntime-web's WASM runtime, from its package.
//
// None of these are tracked in git (rule 8): web/public/voice and
// web/public/ort are gitignored, and this runs before every build and dev.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(repoRoot, ".cache", "kokoro");
const voiceOut = path.join(repoRoot, "web", "public", "voice");
const ortOut = path.join(repoRoot, "web", "public", "ort");

export const REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
export const PART_BYTES = 20 * 1024 * 1024;
export const NARRATOR = "bm_george";

// SHA-256 of every staged file. A changed upstream byte fails the build.
export const MODEL_FILES = {
  "config.json": "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
  "tokenizer.json": "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
  "tokenizer_config.json": "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
  "onnx/model_quantized.onnx": "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
};
export const VOICE_SHA256 = "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc";
const ORT_FILES = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function cached(file, expected) {
  const target = path.join(cacheDir, REVISION, file);
  if (existsSync(target) && sha256(readFileSync(target)) === expected) return readFileSync(target);
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`;
  console.log(`fetch-voice: downloading ${file}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch-voice: ${url} answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== expected) throw new Error(`fetch-voice: ${file} sha256 ${got}, pinned ${expected}`);
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

export async function stage() {
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
  // The manifest the page reads to stitch the model back together.
  writeFileSync(
    path.join(voiceOut, "manifest.json"),
    JSON.stringify({ repo: REPO, revision: REVISION, model: "onnx/model_quantized.onnx", sha256: MODEL_FILES["onnx/model_quantized.onnx"], parts, narrator: NARRATOR }, null, 2) + "\n",
  );

  const voiceSrc = path.join(resolvePackageDir("kokoro-js"), "voices", `${NARRATOR}.bin`);
  const voiceBuf = readFileSync(voiceSrc);
  if (sha256(voiceBuf) !== VOICE_SHA256) throw new Error(`fetch-voice: ${NARRATOR}.bin does not match its pin`);
  mkdirSync(path.join(voiceOut, "voices"), { recursive: true });
  writeFileSync(path.join(voiceOut, "voices", `${NARRATOR}.bin`), voiceBuf);

  rmSync(ortOut, { recursive: true, force: true });
  mkdirSync(ortOut, { recursive: true });
  const ortDist = path.join(resolvePackageDir("onnxruntime-web"), "dist");
  for (const f of ORT_FILES) copyFileSync(path.join(ortDist, f), path.join(ortOut, f));

  console.log(`fetch-voice: staged Kokoro-82M q8 in ${parts.length} parts, voice ${NARRATOR}, onnxruntime-web`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stage().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
