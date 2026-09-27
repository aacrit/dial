// The voice's files as the page and the render worker both store them, kept
// apart from voice.ts so the page can save a work for offline (offline/store.ts)
// without loading the speech runtime. Every file comes from this origin
// (Law 1) and is checked against its pin before it is used or kept.

import { neededBytes, runtimeCacheKey, runtimeCacheName, voiceCacheName, type Need, type SizedManifest, type VoicePins } from "./voice-cache";

/** Where the model, its tokenizer and config are served and keyed. */
export const MODELS = "/voice/models/";

/** kokoro-js reads each voice from this cache, under its Hugging Face address, before it would fetch one. */
export const KOKORO_VOICES_CACHE = "kokoro-voices";

/** The key kokoro-js looks a voice up by. Never fetched: the file is put there from this origin first. */
export function hfVoiceKey(repo: string, id: string): string {
  return `https://huggingface.co/${repo}/resolve/main/voices/${id}.bin`;
}

/**
 * The cached voice keys (kokoro-voices) whose voice this build does not pin:
 * a voice a past cast used and the current one no longer does. Only keys in
 * the Hugging Face voice form are considered; anything else is left alone.
 */
export function unpinnedVoiceKeys(keys: readonly string[], repo: string, pins: Readonly<Record<string, string>>): string[] {
  const prefix = hfVoiceKey(repo, "");
  const stem = prefix.slice(0, -".bin".length);
  return keys.filter((k) => {
    if (!k.startsWith(stem) || !k.endsWith(".bin")) return false;
    const id = k.slice(stem.length, -".bin".length);
    return !Object.hasOwn(pins, id);
  });
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads a response's body, counting bytes as they arrive, so a meter never runs ahead of the download. */
export async function readCounted(res: Response, count: (bytes: number) => void): Promise<ArrayBuffer> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    count(buf.byteLength);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    count(value.byteLength);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out.buffer;
}

export interface StitchManifest {
  repo: string;
  parts: string[];
  sha256: string;
}

/** Fetches the model's parts from this origin, joins them and checks the whole against its pin. */
export async function stitchModel(m: StitchManifest, count: (bytes: number) => void, signal?: AbortSignal): Promise<Response> {
  const buffers: ArrayBuffer[] = [];
  for (const part of m.parts) {
    const res = await fetch(`/voice/models/${m.repo}/onnx/${part}`, { signal });
    if (!res.ok) throw new Error(`voice part ${part}: ${res.status}`);
    buffers.push(await readCounted(res, count));
  }
  const blob = new Blob(buffers);
  const whole = await blob.arrayBuffer();
  if ((await sha256Hex(whole)) !== m.sha256) throw new Error("voice: the model did not match its pin");
  return new Response(blob, { headers: { "content-type": "application/octet-stream", "content-length": String(blob.size) } });
}

/** The manifest fields the presence check reads (voice.ts VoiceManifest has them all). */
export interface PresenceManifest extends VoicePins, SizedManifest {
  voices: Record<string, string>;
}

/**
 * What a first use of `wanted` would download, from what is present on this
 * device: a quick look for the Seal's speed-test line, before anything
 * runs. It hashes nothing and opens no cache that does not already exist.
 * The loader (voice.ts loadVoice) still checks every file against its pin
 * when the test runs, and its own warming line states the exact size.
 */
export async function voicePresence(wanted: readonly string[]): Promise<{ bytes: number; need: Need; missingVoices: number }> {
  const res = await fetch("/voice/manifest.json");
  if (!res.ok) throw new Error(`voice manifest: ${res.status}`);
  const m = (await res.json()) as PresenceManifest;
  const names = new Set(await caches.keys());
  const open = (name: string) => (names.has(name) ? caches.open(name) : Promise.resolve(null));
  const [cache, runtimeCache, voices] = await Promise.all([open(voiceCacheName(m)), open(runtimeCacheName(m)), open(KOKORO_VOICES_CACHE)]);
  const has = async (c: Cache | null, key: string) => !!c && !!(await c.match(key));
  const cast = [...new Set(wanted)];
  const heldVoices = new Set<string>();
  for (const id of cast) if (await has(voices, hfVoiceKey(m.repo, id))) heldVoices.add(id);
  const modelFiles = new Set<string>();
  for (const p of Object.keys(m.sizes)) if (p.startsWith(`${MODELS}${m.repo}/`) && (await has(cache, p))) modelFiles.add(p);
  return neededBytes(m, cast, {
    model: await has(cache, `${MODELS}${m.repo}/${m.model}`),
    modelFiles,
    runtime: await has(runtimeCache, runtimeCacheKey(m)),
    voices: heldVoices,
  });
}
