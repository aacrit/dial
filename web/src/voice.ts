// Loads Kokoro-82M from this origin only (Law 1). The model's weights are
// served in parts (scripts/fetch-voice.mjs) and stitched here; the model,
// its tokenizer, the cast's voice files and the runtime's WASM are kept in the tab's
// Cache Storage after the first load, so they are fetched once. Nothing is
// ever sent anywhere.
//
// Progress is reported against the manifest's totalBytes: every byte the
// tab downloads for the voice (model parts, tokenizer and config, every voice
// file in the palette, the runtime's .wasm and .mjs). Only bytes that have actually arrived
// are counted, so the meter never runs ahead of the download.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { runtimeCacheKey, runtimeCacheName, staleVoiceCaches, voiceCacheName, type VoicePins } from "./voice-cache";

export interface VoiceManifest extends VoicePins {
  repo: string;
  model: string;
  sha256: string;
  parts: string[];
  narrator: string;
  /** Every voice file in the casting palette, by id, with its SHA-256 pin. */
  voices: Record<string, string>;
  totalBytes: number;
}

/** fromDevice: the voice was already kept on this device, so nothing large downloads. */
export type VoiceProgress = (loaded: number, total: number, fromDevice: boolean) => void;

/** kept: every file was stored on this device; false when a write failed (for example, no space). */
export interface LoadedVoice {
  tts: KokoroTTS;
  manifest: VoiceManifest;
  kept: boolean;
}

const MODELS = "/voice/models/";

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A cache write that may fail (a full quota) without stopping the voice. Returns whether it was kept. */
async function keep(cache: Cache, key: string, response: Response): Promise<boolean> {
  try {
    await cache.put(key, response);
    return true;
  } catch {
    // Out of space or storage blocked: the bytes stay in memory for this visit.
    return false;
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

/**
 * Drops a cached file that no longer matches its pin, so it is fetched again.
 * Returns the cached bytes when they match, so a caller that needs them
 * (the runtime's .wasm) reads and hashes the file once per load, not twice.
 */
async function dropIfUnpinned(cache: Cache, key: string, pin: string): Promise<ArrayBuffer | undefined> {
  const hit = await (await cache.match(key))?.arrayBuffer();
  if (!hit) return undefined;
  if ((await sha256Hex(hit)) !== pin) {
    await cache.delete(key);
    return undefined;
  }
  return hit;
}

export async function loadVoice(onProgress: VoiceProgress): Promise<LoadedVoice> {
  const manifestRes = await fetch("/voice/manifest.json");
  if (!manifestRes.ok) throw new Error(`voice manifest: ${manifestRes.status}`);
  const manifest = (await manifestRes.json()) as VoiceManifest;
  const current = [voiceCacheName(manifest), runtimeCacheName(manifest)];
  for (const stale of staleVoiceCaches(await caches.keys(), current)) await caches.delete(stale);
  const cache = await caches.open(voiceCacheName(manifest));
  const runtimeCache = await caches.open(runtimeCacheName(manifest));
  let kept = true;
  const hold = async (c: Cache, key: string, response: Response) => {
    if (!(await keep(c, key, response))) kept = false;
  };

  // kokoro-js looks for a voice in the "kokoro-voices" cache under its
  // Hugging Face address before it would fetch one; put ours there first,
  // so that fetch never happens. A cached voice that fails its pin is dropped.
  const voiceKey = (id: string) => `https://huggingface.co/${manifest.repo}/resolve/main/voices/${id}.bin`;
  const voices = await caches.open("kokoro-voices");
  const runtimeKey = runtimeCacheKey(manifest);
  let voicesKept = true;
  for (const [id, pin] of Object.entries(manifest.voices)) {
    if (!(await dropIfUnpinned(voices, voiceKey(id), pin))) voicesKept = false;
  }
  const cachedRuntime = await dropIfUnpinned(runtimeCache, runtimeKey, manifest.runtimeSha256);
  const modelKey = `${MODELS}${manifest.repo}/${manifest.model}`;
  const fromDevice = !!(await cache.match(modelKey)) && !!cachedRuntime && voicesKept;

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
        await hold(cache, key, stitched.clone());
        return stitched;
      }
      // Tokenizer and config: fetched here so their bytes are counted too.
      if (!key.startsWith(MODELS)) return undefined;
      const res = await fetch(`/voice/models/${key.slice(MODELS.length)}`);
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      count(buf.byteLength);
      const file = new Response(buf, { headers: res.headers });
      await hold(cache, key, file.clone());
      return file;
    },
    async put(request: string | Request, response: Response): Promise<void> {
      const key = typeof request === "string" ? request : request.url;
      if (key.startsWith("/voice/")) await hold(cache, key, response);
    },
  };
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = "/ort/";
    // The runtime's WASM: the cached bytes already read and checked against
    // their pin above, else a fresh copy from this origin; handed to the
    // runtime, which then does not fetch it again.
    let binary = cachedRuntime;
    if (!binary) {
      const res = await fetch(`/ort/${manifest.runtime}`);
      if (!res.ok) throw new Error(`voice runtime: ${res.status}`);
      binary = await res.arrayBuffer();
      count(binary.byteLength);
      if ((await sha256Hex(binary)) !== manifest.runtimeSha256) throw new Error("voice: the runtime did not match its pin");
      await hold(runtimeCache, runtimeKey, new Response(binary, { headers: { "content-type": "application/wasm" } }));
    }
    wasm.wasmBinary = binary;
  }

  for (const [id, pin] of Object.entries(manifest.voices)) {
    if (await voices.match(voiceKey(id))) continue;
    const res = await fetch(`/voice/voices/${id}.bin`);
    if (!res.ok) throw new Error(`voice ${id}: ${res.status}`);
    const buf = await res.arrayBuffer();
    count(buf.byteLength);
    if ((await sha256Hex(buf)) !== pin) throw new Error("voice: the voice file did not match its pin");
    try {
      await voices.put(voiceKey(id), new Response(buf, { headers: res.headers }));
    } catch {
      kept = false;
    }
    // kokoro-js reads each voice from this cache; if one could not be kept,
    // it must not fall back to fetching from another origin.
    if (!(await voices.match(voiceKey(id)))) throw new Error("QuotaExceededError: there is no room to keep the voice on this device");
  }

  const tts = await KokoroTTS.from_pretrained(manifest.repo, { dtype: "q8", device: "wasm" });
  // The runtime's .mjs is imported by the runtime itself while the model
  // loads; once the voice is ready, every byte in the total is in place.
  onProgress(manifest.totalBytes, manifest.totalBytes, fromDevice);
  return { tts, manifest, kept };
}
