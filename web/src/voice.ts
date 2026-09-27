// Loads Kokoro-82M from this origin only (Law 1). The model's weights are
// served in parts (scripts/fetch-voice.mjs) and stitched here; the model,
// its tokenizer, the cast's voice files and the runtime's WASM are kept in the tab's
// Cache Storage after the first load, so they are fetched once. Nothing is
// ever sent anywhere.
//
// Progress is reported against the bytes this visit still needs: of the
// manifest's per-file sizes, only the files not already held on this device
// (and matching their pins), and only the voices this work's cast uses
// (voice-cache.ts neededBytes). Only bytes that have actually arrived are
// counted, so the meter never runs ahead of the download.

import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { KOKORO_VOICES_CACHE, MODELS, hfVoiceKey, readCounted, sha256Hex, stitchModel } from "./voice-files";
import { neededBytes, runtimeCacheKey, runtimeCacheName, staleVoiceCaches, voiceCacheName, type Need, type SizedManifest, type VoicePins } from "./voice-cache";

export interface VoiceManifest extends VoicePins, SizedManifest {
  sha256: string;
  /** Every voice file in the casting palette, by id, with its SHA-256 pin. */
  voices: Record<string, string>;
  /** Every staged byte; no single visit downloads all of it. */
  totalBytes: number;
}

/** total: the bytes this visit needs; need: nothing, only voices, or the model and runtime too. */
export type VoiceProgress = (loaded: number, total: number, need: Need, missingVoices: number) => void;

/** kept: every file was stored on this device; false when a write failed (for example, no space). */
export interface LoadedVoice {
  tts: KokoroTTS;
  manifest: VoiceManifest;
  kept: boolean;
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

/** Loads the model, the runtime and exactly the voices in `wanted` (the work's cast), each checked against its pin. */
export async function loadVoice(wanted: readonly string[], onProgress: VoiceProgress): Promise<LoadedVoice> {
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
  const voiceKey = (id: string) => hfVoiceKey(manifest.repo, id);
  const voices = await caches.open(KOKORO_VOICES_CACHE);
  const runtimeKey = runtimeCacheKey(manifest);
  const cast = [...new Set(wanted)];
  for (const id of cast) if (!Object.hasOwn(manifest.voices, id)) throw new Error(`voice: ${id} is not pinned`);
  const heldVoices = new Set<string>();
  for (const id of cast) {
    if (await dropIfUnpinned(voices, voiceKey(id), manifest.voices[id]!)) heldVoices.add(id);
  }
  const cachedRuntime = await dropIfUnpinned(runtimeCache, runtimeKey, manifest.runtimeSha256);
  const modelKey = `${MODELS}${manifest.repo}/${manifest.model}`;
  const modelFiles = new Set<string>();
  for (const p of Object.keys(manifest.sizes)) if (p.startsWith(`${MODELS}${manifest.repo}/`) && (await cache.match(p))) modelFiles.add(p);
  const { bytes: total, need, missingVoices } = neededBytes(manifest, cast, {
    model: !!(await cache.match(modelKey)),
    modelFiles,
    runtime: !!cachedRuntime,
    voices: heldVoices,
  });

  let loaded = 0;
  const count = (bytes: number) => {
    loaded += bytes;
    onProgress(Math.min(loaded, total), total, need, missingVoices);
  };
  onProgress(0, total, need, missingVoices);

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
      const buf = await readCounted(res, count);
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

  for (const id of cast) {
    const pin = manifest.voices[id]!;
    if (heldVoices.has(id)) continue;
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
  onProgress(total, total, need, missingVoices);
  return { tts, manifest, kept };
}
