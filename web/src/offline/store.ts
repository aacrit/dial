// "Save for offline" and "Remove", on this device only. Saving downloads
// this site's own files (Law 1: every fetch here names a path in
// privacy-allowlist.json) and keeps them in the browser's Cache Storage:
//
// - the voice in the same caches the render worker reads (voice.ts): the
//   model (checked against its pin), its tokenizer and config (which, as in
//   voice.ts, have no pin of their own), the runtime's .wasm and the voices
//   the work's cast uses (each checked against its pin); a file already
//   kept is never downloaded again. What is already kept is judged by
//   presence here. On each load the render worker checks the runtime and
//   the voices against their pins again; the model is judged by presence
//   too (it was checked when it was kept), in a cache named for its pin
//   (voice-cache.ts voiceCacheName), so a changed pin downloads it afresh;
// - the work's text, the voice manifest and the runtime's script in the
//   saved cache (offline/routes.ts SAVED_CACHE), which the offline helper
//   reads when there is no connection;
// - the app shell, which the offline helper keeps (web/src/sw.ts).
//
// A work with a prepared recording saves that instead of the voice: its
// parts and timing index (each checked against its pin) and the voice
// manifest, in the saved cache; its text records no
// voices ("none"). Remove deletes its text and its recording's files.
//
// Each saved text records its work's voices (VOICES_HEADER), as cast when
// it was saved. Remove deletes the work's text and each of its recorded
// voices no other saved work records (plan.ts voicesToRemove); if any saved
// work's record is missing, it deletes no voice. Nothing is ever sent.

import type { VoiceManifest } from "../voice";
import { runtimeCacheKey, runtimeCacheName, voiceCacheName, type Held } from "../voice-cache";
import { KOKORO_VOICES_CACHE, MODELS, hfVoiceKey, readCounted, sha256Hex, stitchModel } from "../voice-files";
import { NO_VOICES, offlineExtras, recordingKeysOf, parseVoices, recordingFiles, savePlan, unionVoices, voicesToRemove, type PinnedFile, type RecordingPlan, type SavePlan } from "./plan";
import type { RecordingIndex } from "../recording/timing";
import type { RecordingFormat } from "../recording/source";
import { SAVED_CACHE } from "./routes";


/** On a saved text: the work's voices, comma separated, as cast when it was saved. */
export const VOICES_HEADER = "x-dial-voices";

const workKey = (slug: string) => `/works/${slug}.txt`;
const MANIFEST_KEY = "/voice/manifest.json";

/** Whether this browser can keep works for offline at all: Cache Storage and an offline helper. */
export function canSaveOffline(): boolean {
  return typeof caches !== "undefined" && "serviceWorker" in navigator && window.isSecureContext;
}

let probe: Promise<boolean> | null = null;

/**
 * Whether offline saving works in this browser: Cache Storage, an offline
 * helper in control of this page, and that helper answering the render
 * worker's requests too (offline/probe.worker.ts). The answer is kept for
 * the visit; after a no, it is asked again only once a helper takes control
 * of the page (controllerchange), never on every station.
 */
export function offlineWorks(timeoutMs = 10_000): Promise<boolean> {
  probe ??= (async (): Promise<boolean> => {
    if (!canSaveOffline()) return false;
    const sw = navigator.serviceWorker;
    if (!sw.controller) {
      await Promise.race([new Promise((r) => sw.addEventListener("controllerchange", r, { once: true })), new Promise((r) => setTimeout(r, timeoutMs))]);
      if (!sw.controller) return false;
    }
    return new Promise<boolean>((resolve) => {
      const w = new Worker(new URL("./probe.worker.ts", import.meta.url), { type: "module" });
      const done = (ok: boolean) => {
        clearTimeout(timer);
        w.terminate();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      w.onmessage = (e: MessageEvent<boolean>) => done(e.data === true);
      w.onerror = () => done(false);
    });
  })().then((ok) => {
    if (!ok && "serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          probe = null;
        },
        { once: true },
      );
    }
    return ok;
  });
  return probe;
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

/**
 * Whichever encoding of a work's prepared recording is actually kept in the
 * saved cache (a routing hint for opening it offline: a work saved before
 * this browser's format changed, or from before T5b, may hold the other
 * one). Not a pin check: Recording still verifies every file's hash as
 * usual. `null` when neither is kept (nothing saved, or saved with a voice
 * instead, from before T5).
 */
export async function savedRecordingFormat(slug: string): Promise<RecordingFormat | null> {
  const cache = await caches.open(SAVED_CACHE);
  if (await cache.match(`/recordings/${slug}/part0.m4a`)) return "m4a";
  if (await cache.match(`/recordings/${slug}/part0.webm`)) return "opus";
  return null;
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

/**
 * Asks the helper in control of this page, the one that answers when there
 * is no connection. Its shell is its own build's, complete or not at all
 * (web/src/sw.ts): after a release, until every Dial tab closes, it may be
 * the previous build's, which still plays offline as a whole.
 */
export interface ShellState {
  /** Every file of the helper's shell is kept. */
  ok: boolean;
  /** The helper's offline-compatibility key (null when there is no helper or no answer). */
  key: string | null;
}

async function askHelper(type: "ensure-shell" | "shell-status", timeoutMs: number): Promise<ShellState> {
  const helper = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null;
  return ask(helper, type, timeoutMs);
}

function ask(helper: ServiceWorker | null | undefined, type: "ensure-shell" | "shell-status", timeoutMs: number): Promise<ShellState> {
  if (!helper) return Promise.resolve({ ok: false, key: null });
  return new Promise<ShellState>((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve({ ok: false, key: null }), timeoutMs);
    ch.port1.onmessage = (e: MessageEvent<{ ok?: boolean; key?: string | null }>) => {
      clearTimeout(timer);
      resolve({ ok: e.data?.ok === true, key: typeof e.data?.key === "string" ? e.data.key : null });
    };
    helper.postMessage({ type }, [ch.port2]);
  });
}

/**
 * Asks the offline helper to keep every file of its app shell; true once it
 * has. A newer helper waiting to take over (a release while this tab is
 * open) is asked too, so the shell it serves once it activates is whole for
 * the work being saved now; its answer does not decide the save, since it
 * also completes its shell when it activates (offline/shell-cache.ts).
 */
export async function ensureShell(timeoutMs = 30_000): Promise<boolean> {
  const [own] = await Promise.all([askHelper("ensure-shell", timeoutMs), ask(await waitingHelper(), "ensure-shell", timeoutMs)]);
  return own.ok;
}

/** A newer helper installed and waiting to take over, if there is one. */
async function waitingHelper(): Promise<ServiceWorker | null> {
  try {
    const container = "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
    if (typeof container?.getRegistration !== "function") return null;
    return (await container.getRegistration())?.waiting ?? null;
  } catch {
    return null;
  }
}

/** Whether every file of the serving helper's shell is kept (the helper checks each one), and the helper's key. */
export function shellState(timeoutMs = 5_000): Promise<ShellState> {
  return askHelper("shell-status", timeoutMs);
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
  // The app's own files first: without them nothing plays offline, so nothing else is downloaded.
  if (!(await ensureShell())) throw new Error("ShellError: the app's own files could not be kept");
  signal.throwIfAborted();
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
  const textBytes = new TextEncoder().encode(text).byteLength;
  await put(saved, workKey(slug), new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", [VOICES_HEADER]: [...voices].join(",") } }));
  count(textBytes);
}

// ---- A work with a prepared recording ---------------------------------------

/** What saving a prepared recording needs. */
export interface RecordingSave {
  slug: string;
  index: RecordingIndex;
  /** The index file's size as served, and its pin compiled into this page. */
  indexBytes: number;
  indexSha256: string;
  /** Which encoding this browser opened the recording in (T5b): what gets saved and kept. */
  format: "opus" | "m4a";
}

async function filesOf(man: Manifest, r: RecordingSave): Promise<PinnedFile[]> {
  return recordingFiles(r.slug, r.index.parts, { bytes: r.indexBytes, sha256: r.indexSha256 }, { bytes: man.bytes, sha256: await sha256Hex(new TextEncoder().encode(man.text).buffer) }, r.format);
}

/** path@pin for every file already read back and found to hash to its pin, this visit. A changed pin is a new key, so it is read again. */
const verified = new Set<string>();

/** Whether `f` is kept and its kept bytes hash to its pin (read once per path and pin). A copy that does not match is not kept. */
export async function keptAsPinned(cache: Cache, f: PinnedFile): Promise<boolean> {
  const hit = await cache.match(f.path);
  if (!hit) return false;
  const key = `${f.path}@${f.sha256}`;
  if (verified.has(key)) return true;
  const ok = (await sha256Hex(await hit.arrayBuffer())) === f.sha256;
  if (ok) verified.add(key);
  return ok;
}

export async function recordingPlanFor(man: Manifest, r: RecordingSave, textBytes: number): Promise<RecordingPlan> {
  const saved = await caches.open(SAVED_CACHE);
  const files = [];
  for (const f of await filesOf(man, r)) files.push({ ...f, kept: await keptAsPinned(saved, f) });
  return { kind: "recording", textBytes, textSaved: !!(await saved.match(workKey(r.slug))), files };
}

/**
 * Saves a work's prepared recording for offline: the app's own files first,
 * then every file not kept as pinned (a missing one, or one kept from
 * another release, is fetched again and checked against its pin), then the
 * text last, so a cancelled or failed save never leaves a work marked saved.
 */
export async function saveRecording(man: Manifest, r: RecordingSave, text: string, signal: AbortSignal, onProgress: (loaded: number) => void): Promise<void> {
  let loaded = 0;
  const count = (n: number) => {
    loaded += n;
    onProgress(loaded);
  };
  if (!(await ensureShell())) throw new Error("ShellError: the app's own files could not be kept");
  signal.throwIfAborted();
  const saved = await caches.open(SAVED_CACHE);
  for (const f of await filesOf(man, r)) {
    signal.throwIfAborted();
    if (await keptAsPinned(saved, f)) continue;
    if (f.path === MANIFEST_KEY) {
      count(f.bytes);
      await put(saved, MANIFEST_KEY, new Response(man.text, { headers: { "content-type": "application/json" } }));
      continue;
    }
    const res = await fetch(`/recordings/${f.path.slice("/recordings/".length)}`, { signal });
    if (!res.ok) throw new Error(`recording file: ${res.status}`);
    const buf = await readCounted(res, count);
    if ((await sha256Hex(buf)) !== f.sha256) throw new Error("recording: a file did not match its pin");
    await put(saved, f.path, new Response(buf, { headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" } }));
    verified.add(`${f.path}@${f.sha256}`);
  }
  signal.throwIfAborted();
  const textBytes = new TextEncoder().encode(text).byteLength;
  await put(saved, workKey(r.slug), new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", [VOICES_HEADER]: NO_VOICES } }));
  count(textBytes);
}

/** Every saved work's recorded voices, by slug; null where a text carries no usable record. */
export async function savedVoiceRecords(): Promise<Map<string, readonly string[] | null>> {
  const cache = await caches.open(SAVED_CACHE);
  const out = new Map<string, readonly string[] | null>();
  for (const req of await cache.keys()) {
    const m = /^\/works\/([a-z0-9-]+)\.txt$/.exec(new URL(req.url).pathname);
    if (!m) continue;
    const hit = await cache.match(req);
    out.set(m[1]!, parseVoices(hit?.headers.get(VOICES_HEADER) ?? null));
  }
  return out;
}

/**
 * Keeps a saved work's voice record covering today's cast: the record
 * becomes the union of what it held and `voices` (a recast may have added
 * one). Nothing is written when the record already covers them, or when the
 * work is not saved.
 */
export async function coverVoiceRecord(slug: string, voices: readonly string[]): Promise<void> {
  const cache = await caches.open(SAVED_CACHE);
  const hit = await cache.match(workKey(slug));
  if (!hit) return;
  const old = parseVoices(hit.headers.get(VOICES_HEADER));
  const merged = unionVoices(old, voices);
  if (old && merged.length === old.length) return;
  const headers = new Headers(hit.headers);
  headers.set(VOICES_HEADER, merged.join(","));
  await put(cache, workKey(slug), new Response(await hit.blob(), { headers }));
}

/**
 * Removes a saved work: its text, its prepared recording's files, and each of its recorded voices that no
 * other saved work records or uses in today's cast (`todayCasts`, for every
 * other saved work whose text this page holds), so never a voice another
 * saved work needs. The voice model and runtime stay: every work, saved or
 * not, uses them.
 */
export async function removeWork(m: VoiceManifest, slug: string, todayCasts: ReadonlyMap<string, readonly string[]>): Promise<void> {
  const records = await savedVoiceRecords();
  const cache = await caches.open(SAVED_CACHE);
  await cache.delete(workKey(slug));
  // Its prepared recording, if it was saved with one; the shared lists stay.
  for (const key of recordingKeysOf((await cache.keys()).map((r) => new URL(r.url).pathname), slug)) await cache.delete(key);
  const kv = await caches.open(KOKORO_VOICES_CACHE);
  for (const id of voicesToRemove(slug, records, todayCasts)) await kv.delete(hfVoiceKey(m.repo, id));
}
