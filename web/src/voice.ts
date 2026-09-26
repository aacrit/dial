// Loads Kokoro-82M from this origin only (Law 1). The model's weights are
// served in parts (scripts/fetch-voice.mjs) and stitched here; the model,
// its tokenizer, the voice file and the runtime's WASM are kept in the tab's
// Cache Storage after the first load, so they are fetched once. Nothing is
// ever sent anywhere.
//
// Progress is reported against the manifest's totalBytes: every byte the
// tab downloads for the voice (model parts, tokenizer and config, the voice
// file, the runtime's .wasm and .mjs). Only bytes that have actually arrived
// are counted, so the meter never runs ahead of the download.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { runtimeCacheKey, staleVoiceCaches, voiceCacheName, type VoicePins } from "./voice-cache";

export interface VoiceManifest extends VoicePins {
  repo: string;
  model: string;
  sha256: string;
  parts: string[];
  narrator: string;
  totalBytes: number;
}

/** fromDevice: the voice was already kept on this device, so nothing large downloads. */
export type VoiceProgress = (loaded: number, total: number, fromDevice: boolean) => void;

const MODELS = "/voice/models/";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A cache write that may fail (a full quota) without stopping the voice. */
async function keep(cache: Cache, key: string, response: Response): Promise<void> {
  try {
    await cache.put(key, response);
  } catch {
    // Out of space or storage blocked: the bytes stay in memory for this visit.
  }
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

/** The runtime's WASM from the cache if it still matches its pin, else from this origin. */
async function loadRuntime(m: VoiceManifest, cache: Cache, count: (bytes: number) => void): Promise<ArrayBuffer> {
  const key = runtimeCacheKey(m);
  const hit = await (await cache.match(key))?.arrayBuffer();
  if (hit && (await sha256Hex(hit)) === m.runtimeSha256) return hit;
  if (hit) await cache.delete(key);
  const res = await fetch(`/ort/${m.runtime}`);
  if (!res.ok) throw new Error(`voice runtime: ${res.status}`);
  const binary = await res.arrayBuffer();
  count(binary.byteLength);
  if ((await sha256Hex(binary)) !== m.runtimeSha256) throw new Error("voice: the runtime did not match its pin");
  await keep(cache, key, new Response(binary, { headers: { "content-type": "application/wasm" } }));
  return binary;
}

export async function loadVoice(onProgress: VoiceProgress): Promise<{ tts: KokoroTTS; manifest: VoiceManifest }> {
  const manifest = (await (await fetch("/voice/manifest.json")).json()) as VoiceManifest;
  const cacheName = voiceCacheName(manifest);
  for (const stale of staleVoiceCaches(await caches.keys(), cacheName)) await caches.delete(stale);
  const cache = await caches.open(cacheName);

  // kokoro-js looks for a voice in the "kokoro-voices" cache under its
  // Hugging Face address before it would fetch one; put ours there first,
  // so that fetch never happens.
  const voiceKey = `https://huggingface.co/${manifest.repo}/resolve/main/voices/${manifest.narrator}.bin`;
  const voices = await caches.open("kokoro-voices");
  const modelKey = `${MODELS}${manifest.repo}/${manifest.model}`;
  const fromDevice =
    !!(await cache.match(modelKey)) && !!(await cache.match(runtimeCacheKey(manifest))) && !!(await voices.match(voiceKey));

  let loaded = 0;
  const count = (bytes: number) => {
    loaded += bytes;
    onProgress(loaded, manifest.totalBytes, fromDevice);
  };
  onProgress(0, manifest.totalBytes, fromDevice);

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
        await keep(cache, key, stitched.clone());
        return stitched;
      }
      // Tokenizer and config: fetched here so their bytes are counted too.
      if (!key.startsWith(MODELS)) return undefined;
      const res = await fetch(`/voice/models/${key.slice(MODELS.length)}`);
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      count(buf.byteLength);
      const file = new Response(buf, { headers: res.headers });
      await keep(cache, key, file.clone());
      return file;
    },
    async put(request: string | Request, response: Response): Promise<void> {
      const key = typeof request === "string" ? request : request.url;
      if (key.startsWith("/voice/")) await keep(cache, key, response);
    },
  };
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = "/ort/";
    // Handed to the runtime, which then does not fetch the WASM again.
    wasm.wasmBinary = await loadRuntime(manifest, cache, count);
  }

  if (!(await voices.match(voiceKey))) {
    const res = await fetch(`/voice/voices/${manifest.narrator}.bin`);
    if (!res.ok) throw new Error(`voice ${manifest.narrator}: ${res.status}`);
    const buf = await res.arrayBuffer();
    count(buf.byteLength);
    try {
      await voices.put(voiceKey, new Response(buf, { headers: res.headers }));
    } catch {
      // Handled just below.
    }
    // kokoro-js reads the voice from this cache; if it could not be kept,
    // it must not fall back to fetching from another origin.
    if (!(await voices.match(voiceKey))) throw new Error("voice: there is no room to keep the voice on this device");
  }

  const tts = await KokoroTTS.from_pretrained(manifest.repo, { dtype: "q8", device: "wasm" });
  // The runtime's .mjs is imported by the runtime itself while the model
  // loads; once the voice is ready, every byte in the total is in place.
  onProgress(manifest.totalBytes, manifest.totalBytes, fromDevice);
  return { tts, manifest };
}
