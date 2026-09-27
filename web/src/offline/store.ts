// "Save for offline" and "Remove", on this device only. Saving downloads
// this site's own files (Law 1: every fetch here names a path in
// privacy-allowlist.json) and keeps them in the browser's Cache Storage:
//
// - the voice in the same caches the render worker reads (voice.ts): the
//   model and tokenizer, the runtime's .wasm keyed to its pin, and the
//   voices the work's cast uses, each checked against its pin; a file
//   already kept is never downloaded again;
// - the work's text, the voice manifest and the runtime's script in the
//   saved cache (offline/routes.ts SAVED_CACHE), which the offline helper
//   reads when there is no connection;
// - the app shell, which the offline helper keeps (web/src/sw.ts).
//
// Remove deletes the work's text and each voice no other saved work uses
// (plan.ts voicesToRemove). Nothing is ever sent.

import type { VoiceManifest } from "../voice";
import { runtimeCacheKey, runtimeCacheName, voiceCacheName, type Held } from "../voice-cache";
import { KOKORO_VOICES_CACHE, MODELS, hfVoiceKey, readCounted, sha256Hex, stitchModel } from "../voice-files";
import { offlineExtras, savePlan, voicesToRemove, type SavePlan } from "./plan";
import { SAVED_CACHE } from "./routes";

const workKey = (slug: string) => `/works/${slug}.txt`;
const MANIFEST_KEY = "/voice/manifest.json";

/** Whether this browser can keep works for offline at all: Cache Storage and an offline helper. */
export function canSaveOffline(): boolean {
  return typeof caches !== "undefined" && "serviceWorker" in navigator && window.isSecureContext;
}

/** Registers the offline helper for the whole site. A failure only means no offline; the page works as before. */
export function registerOfflineHelper(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    // No helper (private mode, a blocked worker): the page still works online.
  });
}

export interface Manifest {
  manifest: VoiceManifest;
  /** The manifest's own length in bytes, as fetched. */
  bytes: number;
  text: string;
}

export async function readManifest(): Promise<Manifest> {
  const res = await fetch("/voice/manifest.json");
  if (!res.ok) throw new Error(`voice manifest: ${res.status}`);
  const text = await res.text();
  return { manifest: JSON.parse(text) as VoiceManifest, bytes: new TextEncoder().encode(text).byteLength, text };
}

/** Which works are saved: their texts are in the saved cache. */
export async function savedSlugs(): Promise<Set<string>> {
  const cache = await caches.open(SAVED_CACHE);
  const out = new Set<string>();
  for (const req of await cache.keys()) {
    const m = /^\/works\/([a-z0-9-]+)\.txt$/.exec(new URL(req.url).pathname);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** What this device already holds of the voice for `voices` (presence only; the loader checks pins on every read). */
async function held(m: VoiceManifest, voices: readonly string[]): Promise<Held> {
  const cache = await caches.open(voiceCacheName(m));
  const runtime = await caches.open(runtimeCacheName(m));
  const kv = await caches.open(KOKORO_VOICES_CACHE);
  const modelFiles = new Set<string>();
  for (const p of Object.keys(m.sizes)) if (p.startsWith(`${MODELS}${m.repo}/`) && !p.includes("/onnx/") && (await cache.match(p))) modelFiles.add(p);
  const heldVoices = new Set<string>();
  for (const id of voices) if (await kv.match(hfVoiceKey(m.repo, id))) heldVoices.add(id);
  return {
    model: !!(await cache.match(`${MODELS}${m.repo}/${m.model}`)),
    modelFiles,
    runtime: !!(await runtime.match(runtimeCacheKey(m))),
    voices: heldVoices,
  };
}

/** The offline extras not yet kept, with their sizes. */
async function missingExtras(man: Manifest): Promise<{ path: string; bytes: number }[]> {
  const saved = await caches.open(SAVED_CACHE);
  const out: { path: string; bytes: number }[] = [];
  for (const p of offlineExtras(man.manifest)) {
    if (await saved.match(p)) continue;
    out.push({ path: p, bytes: p === MANIFEST_KEY ? man.bytes : (man.manifest.sizes[p] ?? 0) });
  }
  return out;
}

/** What saving `slug` still costs on this device. */
export async function planFor(man: Manifest, slug: string, voices: readonly string[], textBytes: number): Promise<SavePlan> {
  const saved = await caches.open(SAVED_CACHE);
  const extras = await missingExtras(man);
  return savePlan(
    man.manifest,
    voices,
    await held(man.manifest, voices),
    textBytes,
    !!(await saved.match(workKey(slug))),
    extras,
  );
}

/** Asks the offline helper to keep the whole app shell; true once it has. */
export async function ensureShell(timeoutMs = 20_000): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  const active = reg?.active;
  if (!active) return false;
  return new Promise<boolean>((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(false), timeoutMs);
    ch.port1.onmessage = (e: MessageEvent<{ ok?: boolean }>) => {
      clearTimeout(timer);
      resolve(e.data?.ok === true);
    };
    active.postMessage({ type: "ensure-shell" }, [ch.port2]);
  });
}

/** Whether the helper has kept the shell for the build this page came from. */
export async function shellKept(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return false;
  return !!(await caches.match("/"));
}

/**
 * Asks the browser to keep this site's storage under pressure, on the first
 * save. Returns whether storage is persistent; false when the browser
 * declines or cannot say.
 */
export async function requestPersistence(): Promise<boolean> {
  const s = navigator.storage;
  if (!s?.persisted || !s.persist) return false;
  try {
    if (await s.persisted()) return true;
    return await s.persist();
  } catch {
    return false;
  }
}

export async function isPersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}

/** A cache write; a full quota is reported as such (plan.ts saveFailedLine). */
async function put(cache: Cache, key: string, res: Response): Promise<void> {
  try {
    await cache.put(key, res);
  } catch (err) {
    throw new Error(`QuotaExceededError: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Saves a work for offline: every missing voice file, the extras, then the
 * text last, so a cancelled or failed save never leaves a work marked saved.
 * `onProgress` counts bytes as they arrive against the plan's total.
 */
export async function saveWork(man: Manifest, slug: string, text: string, voices: readonly string[], signal: AbortSignal, onProgress: (loaded: number) => void): Promise<void> {
  const m = man.manifest;
  let loaded = 0;
  const count = (n: number) => {
    loaded += n;
    onProgress(loaded);
  };
  const h = await held(m, voices);
  const cache = await caches.open(voiceCacheName(m));
  const saved = await caches.open(SAVED_CACHE);

  if (!h.model) {
    const stitched = await stitchModel(m, count, signal);
    await put(cache, `${MODELS}${m.repo}/${m.model}`, stitched);
  }
  for (const p of Object.keys(m.sizes)) {
    if (!p.startsWith(`${MODELS}${m.repo}/`) || p.includes("/onnx/") || h.modelFiles.has(p)) continue;
    signal.throwIfAborted();
    const res = await fetch(`/voice/models/${p.slice(MODELS.length)}`, { signal });
    if (!res.ok) throw new Error(`voice file: ${res.status}`);
    const buf = await readCounted(res, count);
    await put(cache, p, new Response(buf, { headers: res.headers }));
  }
  if (!h.runtime) {
    signal.throwIfAborted();
    const res = await fetch(`/ort/${m.runtime}`, { signal });
    if (!res.ok) throw new Error(`voice runtime: ${res.status}`);
    const binary = await readCounted(res, count);
    if ((await sha256Hex(binary)) !== m.runtimeSha256) throw new Error("voice: the runtime did not match its pin");
    await put(await caches.open(runtimeCacheName(m)), runtimeCacheKey(m), new Response(binary, { headers: { "content-type": "application/wasm" } }));
  }
  const kv = await caches.open(KOKORO_VOICES_CACHE);
  for (const id of voices) {
    if (h.voices.has(id)) continue;
    const pin = m.voices[id];
    if (!pin) throw new Error(`voice: ${id} is not pinned`);
    signal.throwIfAborted();
    const res = await fetch(`/voice/voices/${id}.bin`, { signal });
    if (!res.ok) throw new Error(`voice ${id}: ${res.status}`);
    const buf = await readCounted(res, count);
    if ((await sha256Hex(buf)) !== pin) throw new Error("voice: the voice file did not match its pin");
    await put(kv, hfVoiceKey(m.repo, id), new Response(buf, { headers: res.headers }));
  }
  for (const extra of await missingExtras(man)) {
    signal.throwIfAborted();
    if (extra.path === MANIFEST_KEY) {
      count(extra.bytes);
      await put(saved, MANIFEST_KEY, new Response(man.text, { headers: { "content-type": "application/json" } }));
      continue;
    }
    const res = await fetch(`/ort/${extra.path.slice("/ort/".length)}`, { signal });
    if (!res.ok) throw new Error(`voice runtime: ${res.status}`);
    const buf = await readCounted(res, count);
    await put(saved, extra.path, new Response(buf, { headers: res.headers }));
  }
  signal.throwIfAborted();
  if (!(await ensureShell())) throw new Error("the app's own files could not be kept");
  signal.throwIfAborted();
  const textBytes = new TextEncoder().encode(text).byteLength;
  await put(saved, workKey(slug), new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } }));
  count(textBytes);
}

/**
 * Removes a saved work: its text, and each of its voices no other saved
 * work uses. `saved` maps every saved work (this one included) to its voices.
 * The voice model and runtime stay: every work, saved or not, uses them.
 */
export async function removeWork(m: VoiceManifest, slug: string, saved: ReadonlyMap<string, readonly string[]>): Promise<void> {
  const cache = await caches.open(SAVED_CACHE);
  await cache.delete(workKey(slug));
  const kv = await caches.open(KOKORO_VOICES_CACHE);
  for (const id of voicesToRemove(slug, saved)) await kv.delete(hfVoiceKey(m.repo, id));
}
