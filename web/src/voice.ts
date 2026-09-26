// Loads Kokoro-82M from this origin only (Law 1). The model's weights are
// served in parts (scripts/fetch-voice.mjs) and stitched here; every file
// is kept in the tab's Cache Storage after the first load, so the voice
// works offline and is fetched once. Nothing is ever sent anywhere.
//
// Progress is reported against the manifest's totalBytes: every byte the
// tab downloads for the voice (model parts, tokenizer and config, the voice
// file, the runtime's .wasm and .mjs). Only bytes that have actually arrived
// are counted, so the meter never runs ahead of the download.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

export interface VoiceManifest {
  repo: string;
  revision: string;
  model: string;
  sha256: string;
  parts: string[];
  narrator: string;
  totalBytes: number;
}

export type VoiceProgress = (loaded: number, total: number) => void;

const CACHE_PREFIX = "dial-voice-";
const MODELS = "/voice/models/";
const ORT_WASM = "ort-wasm-simd-threaded.jsep.wasm";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function stitchModel(m: VoiceManifest, count: (bytes: number) => void): Promise<Response> {
  const buffers: ArrayBuffer[] = [];
  for (const part of m.parts) {
    const res = await fetch(`/voice/models/${m.repo}/onnx/${part}`);
    if (!res.ok) throw new Error(`voice part ${part}: ${res.status}`);
    const buf = await res.arrayBuffer();
    count(buf.byteLength);
    buffers.push(buf);
  }
  const blob = new Blob(buffers);
  const whole = await blob.arrayBuffer();
  if ((await sha256Hex(whole)) !== m.sha256) throw new Error("voice: the model did not match its pin");
  return new Response(blob, { headers: { "content-type": "application/octet-stream", "content-length": String(blob.size) } });
}

export async function loadVoice(onProgress: VoiceProgress): Promise<{ tts: KokoroTTS; manifest: VoiceManifest }> {
  const manifest = (await (await fetch("/voice/manifest.json")).json()) as VoiceManifest;
  const cache = await caches.open(CACHE_PREFIX + manifest.revision);
  let loaded = 0;
  const count = (bytes: number) => {
    loaded += bytes;
    onProgress(loaded, manifest.totalBytes);
  };
  onProgress(0, manifest.totalBytes);

  // The runtime and the model come from /ort and /voice on this origin.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODELS;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = {
    async match(request: string | Request): Promise<Response | undefined> {
      const key = typeof request === "string" ? request : request.url;
      if (!key.startsWith("/voice/")) return undefined;
      const hit = await cache.match(key);
      if (hit) return hit;
      if (key.endsWith(manifest.model)) {
        const stitched = await stitchModel(manifest, count);
        await cache.put(key, stitched.clone());
        return stitched;
      }
      // Tokenizer and config: fetched here so their bytes are counted too.
      if (!key.startsWith(MODELS)) return undefined;
      const res = await fetch(`/voice/models/${key.slice(MODELS.length)}`);
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      count(buf.byteLength);
      const file = new Response(buf, { headers: res.headers });
      await cache.put(key, file.clone());
      return file;
    },
    async put(request: string | Request, response: Response): Promise<void> {
      const key = typeof request === "string" ? request : request.url;
      if (key.startsWith("/voice/")) await cache.put(key, response);
    },
  };
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = "/ort/";
    // The runtime's WASM is fetched here, counted and kept with the voice,
    // then handed to the runtime, which then does not fetch it again.
    const wasmKey = `/ort/${ORT_WASM}`;
    let binary = await (await cache.match(wasmKey))?.arrayBuffer();
    if (!binary) {
      const res = await fetch(`/ort/${ORT_WASM}`);
      if (!res.ok) throw new Error(`voice runtime: ${res.status}`);
      binary = await res.arrayBuffer();
      count(binary.byteLength);
      await cache.put(wasmKey, new Response(binary, { headers: { "content-type": "application/wasm" } }));
    }
    wasm.wasmBinary = binary;
  }

  // kokoro-js looks for a voice in the "kokoro-voices" cache under its
  // Hugging Face address before it would fetch one; put ours there first,
  // so that fetch never happens.
  const voiceKey = `https://huggingface.co/${manifest.repo}/resolve/main/voices/${manifest.narrator}.bin`;
  const voices = await caches.open("kokoro-voices");
  if (!(await voices.match(voiceKey))) {
    const res = await fetch(`/voice/voices/${manifest.narrator}.bin`);
    if (!res.ok) throw new Error(`voice ${manifest.narrator}: ${res.status}`);
    const buf = await res.arrayBuffer();
    count(buf.byteLength);
    await voices.put(voiceKey, new Response(buf, { headers: res.headers }));
  }

  const tts = await KokoroTTS.from_pretrained(manifest.repo, { dtype: "q8", device: "wasm" });
  // The runtime's .mjs is imported by the runtime itself while the model
  // loads; once the voice is ready, every byte in the total is in place.
  onProgress(manifest.totalBytes, manifest.totalBytes);
  return { tts, manifest };
}
