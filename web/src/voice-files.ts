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

/** The manifest's pins for the model's other files (tokenizer, config), by served path (scripts/fetch-voice.mjs modelFilePins). */
export interface FilePins {
  files: Record<string, string>;
}

/** A model file's pin by its served path; undefined when the manifest pins none, and then the file is never used. */
export function modelFilePin(m: Partial<FilePins>, key: string): string | undefined {
  return m.files && typeof m.files === "object" && Object.hasOwn(m.files, key) ? m.files[key] : undefined;
}

/**
 * Fetches one of the model's other files (tokenizer, config) from this
 * origin, counting bytes as they arrive, and checks it against its pin
 * before it is used or kept (T11, L4). A file the manifest does not pin is
 * never fetched.
 */
export async function fetchPinnedFile(m: Partial<FilePins>, key: string, count: (bytes: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const pin = modelFilePin(m, key);
  if (!pin || !key.startsWith(MODELS)) throw new Error(`voice: ${key} is not pinned`);
  const res = await fetch(`/voice/models/${key.slice(MODELS.length)}`, { signal });
  if (!res.ok) throw new Error(`voice file ${key}: ${res.status}`);
  const buf = await readCounted(res, count);
  if ((await sha256Hex(buf)) !== pin) throw new Error("voice: a model file did not match its pin");
  return buf;
}

/**
 * A model file (tokenizer, config) from the cache, only if its bytes still
 * match their pin; a copy that does not (or one the manifest does not pin)
 * is deleted, so it is fetched again. Checked on every read, as the voices are.
 */
export async function cachedPinnedFile(cache: Pick<Cache, "match" | "delete">, m: Partial<FilePins>, key: string): Promise<ArrayBuffer | undefined> {
  const hit = await (await cache.match(key))?.arrayBuffer();
  if (!hit) return undefined;
  const pin = modelFilePin(m, key);
  if (!pin || (await sha256Hex(hit)) !== pin) {
    await cache.delete(key);
    return undefined;
  }
  return hit;
}

export interface StitchManifest {
  repo: string;
  parts: string[];
  sha256: string;
  /** Every staged file's size in bytes, by served path: the parts' sizes size the one buffer they are read into. */
  sizes: Record<string, number>;
}

/** Where a model part is served: its key in the manifest's sizes (stitchModel fetches the same address, written out for tests/no-network.test.ts). */
export const partPath = (m: Pick<StitchManifest, "repo">, part: string) => `/voice/models/${m.repo}/onnx/${part}`;

/**
 * Reads a response's body straight into `into` at `at`, counting bytes as
 * they arrive; returns the bytes read. A body longer than the room left is
 * refused (it cannot be the pinned file) before anything past it is kept.
 */
export async function readInto(res: Response, into: Uint8Array, at: number, count: (bytes: number) => void): Promise<number> {
  let n = 0;
  const put = (chunk: Uint8Array) => {
    if (at + n + chunk.byteLength > into.byteLength) throw new Error("voice: the model did not match its pin");
    into.set(chunk, at + n);
    n += chunk.byteLength;
    count(chunk.byteLength);
  };
  if (!res.body) {
    put(new Uint8Array(await res.arrayBuffer()));
    return n;
  }
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    try {
      put(value);
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    }
  }
  return n;
}

/**
 * Fetches the model's parts from this origin into one buffer sized from the
 * manifest, checks it against its pin, and hands it back as a Blob-backed
 * response. The 92 MB model is held once while it arrives (never as the
 * parts, a Blob of them and a joined copy all at once, as it was before the
 * pre-Proof audit), and the buffer is let go once the Blob holds the bytes.
 */
export async function stitchModel(m: StitchManifest, count: (bytes: number) => void, signal?: AbortSignal): Promise<Response> {
  const total = m.parts.reduce((sum, part) => sum + (m.sizes[partPath(m, part)] ?? 0), 0);
  if (!(total > 0)) throw new Error("voice: the manifest does not size the model's parts");
  const whole = new Uint8Array(total);
  let at = 0;
  for (const part of m.parts) {
    const res = await fetch(`/voice/models/${m.repo}/onnx/${part}`, { signal });
    if (!res.ok) throw new Error(`voice part ${part}: ${res.status}`);
    at += await readInto(res, whole, at, count);
  }
  if (at !== total || (await sha256Hex(whole.buffer)) !== m.sha256) throw new Error("voice: the model did not match its pin");
  const blob = new Blob([whole]);
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
