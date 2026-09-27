// Dial's offline helper (a service worker), built by scripts/build.mjs into
// dist/sw.js with this build's tag and shell list. Its rules are the pure
// functions in offline/routes.ts. It answers this origin's own GET requests
// only, and makes only two kinds of request itself: the request the page
// made (to this origin, already under the page's CSP), and the shell's own
// paths, all on this origin (tests/offline.test.ts). It never sends anything
// off the device; it tells Dial's open pages which requests it made, for the
// Seal's log.

import { CAST_ENGINE_VERSION } from "./engine/cast-version";
import { REQUESTS_ASK, REQUESTS_MESSAGE, watchWorkerRequests } from "./worker-requests";
import { answerFor, claim, groupByClient, prune, remember, type HelperEntry, type PendingFetch } from "./offline/attribution";
import type { RawEntry } from "./request-log";
import { OFFLINE_HEADER, SAVED_CACHE, isPage, isThisBuild, offlineKey, pageHeaders, pinsOf, route, shellCacheName, shellKey, staleShellCaches } from "./offline/routes";

declare const __BUILD_TAG__: string;
declare const __SHELL__: string[];
declare const __VOICE_PINS__: unknown;

/** This build's offline-compatibility key (offline/routes.ts offlineKey). */
const KEY = offlineKey(pinsOf(__VOICE_PINS__), CAST_ENGINE_VERSION);

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  /** The page that made the request; empty for a navigation, which names the new page in resultingClientId. */
  clientId: string;
  resultingClientId?: string;
  respondWith(r: Promise<Response>): void;
}
interface ExtendableMessageEvent extends ExtendableEvent {
  data: unknown;
  ports: readonly MessagePort[];
}
interface Scope {
  location: Location;
  clients: { claim(): Promise<void> };
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
  addEventListener(type: "message", fn: (e: ExtendableMessageEvent) => void): void;
}

const sw = self as unknown as Scope;
const SHELL = shellCacheName(__BUILD_TAG__);

/** A cacheable copy: a redirected response is stored as its final page, since a page cannot be answered with a redirect it followed. */
async function clean(res: Response): Promise<Response> {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Keeps every shell path not yet kept. True only when the whole shell is in
 * place. A page is kept only if it is this build's (its <meta name="build">
 * is this helper's tag), so a shell never mixes two releases.
 */
async function precache(): Promise<boolean> {
  const cache = await caches.open(SHELL);
  let ok = true;
  for (const path of __SHELL__) {
    if (await cache.match(path)) continue;
    try {
      const res = await fetch(path, { cache: "reload" });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      const copy = await clean(res);
      // Every page kept must be this build's, never another release's.
      if (isPage(copy.headers.get("content-type")) && !isThisBuild(await copy.clone().text(), __BUILD_TAG__)) throw new Error(`${path}: another build`);
      await cache.put(path, copy);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** Whether every shell path is kept. */
async function shellComplete(): Promise<boolean> {
  const cache = await caches.open(SHELL);
  for (const path of __SHELL__) if (!(await cache.match(path))) return false;
  return true;
}

// An incomplete shell fails the install: the browser keeps the previous
// helper (and its complete shell) serving, and tries this one again later.
sw.addEventListener("install", (event) => {
  event.waitUntil(
    precache().then((ok) => {
      if (!ok) throw new Error("offline helper: the shell is incomplete");
    }),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const stale of staleShellCaches(await caches.keys(), __BUILD_TAG__)) await caches.delete(stale);
      await sw.clients.claim();
    })(),
  );
});

// "Save for offline" asks for the whole shell before it downloads anything
// (ensure-shell), and the save row asks whether every shell file is kept
// before it says "Saved" (shell-status). Both answer with this helper's build.
sw.addEventListener("message", (event) => {
  const data = event.data as { type?: string } | null;
  const port = event.ports[0];
  if (!port) return;
  if (data?.type === "ensure-shell") event.waitUntil(precache().then((ok) => port.postMessage({ type: "shell", ok, build: __BUILD_TAG__, key: KEY })));
  else if (data?.type === "shell-status") event.waitUntil(shellComplete().then((ok) => port.postMessage({ type: "shell", ok, build: __BUILD_TAG__, key: KEY })));
});

async function fromShell(request: Request, client: string): Promise<Response> {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  forPage(request, client);
  return fetch(request);
}

async function page(request: Request, client: string): Promise<Response> {
  try {
    forPage(request, client);
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(shellKey(new URL(request.url).pathname));
    if (!hit) return Response.error();
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: pageHeaders(hit.headers) });
  }
}

/** Marks a response as having come through this helper, so the page can tell its render worker is served offline too (offline/probe.worker.ts). */
function marked(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set(OFFLINE_HEADER, "1");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function saved(request: Request, client: string): Promise<Response> {
  const key = new URL(request.url).pathname;
  const cache = await caches.open(SAVED_CACHE);
  try {
    forPage(request, client);
    const res = await fetch(request);
    // Refresh a saved copy (a new release's manifest), keeping its headers
    // (a work's recorded voices); never save what the listener did not.
    const had = res.ok ? await cache.match(key) : undefined;
    if (had) {
      const headers = new Headers(res.headers);
      had.headers.forEach((v, k) => {
        if (k.startsWith("x-dial-")) headers.set(k, v);
      });
      await cache.put(key, new Response(await res.clone().blob(), { status: res.status, headers }));
    }
    return marked(res);
  } catch {
    const hit = await cache.match(key);
    return hit ? marked(hit) : Response.error();
  }
}

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  const r = route(new URL(request.url), request.method, sw.location.origin, request.mode);
  if (r === "ignore") return;
  // The page this request is for, so the Seal's log lists it in that tab only.
  const client = event.clientId || event.resultingClientId || "";
  event.respondWith(r === "page" ? page(request, client) : r === "saved" ? saved(request, client) : fromShell(request, client));
});

// ---- The Seal's log: this helper's requests, told to the tab they were for ----
// The helper's Resource Timing record is its own; no page can read it. Each
// request it makes for a page is noted with that page's client id just
// before the fetch (forPage), and its entry goes to that page only. What it
// fetches for itself (the shell it keeps for every tab) goes to every Dial
// page, marked as the helper's shared download (offline/attribution.ts).
// Only address, time and sizes are posted (worker-requests.ts).

interface Client {
  id: string;
  postMessage(m: unknown): void;
}
interface Clients {
  get(id: string): Promise<Client | undefined>;
  matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly Client[]>;
}
const clients = sw.clients as unknown as Clients;

const pending: PendingFetch[] = [];
const memory: HelperEntry[] = [];

function forPage(request: Request, client: string): void {
  const now = performance.timeOrigin + performance.now();
  prune(pending, now);
  if (client) pending.push({ url: request.url, at: now, clientId: client });
}

const tell = (entries: RawEntry[]) => {
  const claimed = entries.map((entry) => ({ entry, clientId: claim(pending, entry) }));
  remember(memory, claimed);
  const { own, shared } = groupByClient(claimed);
  for (const [id, list] of own) void clients.get(id).then((c) => c?.postMessage({ type: REQUESTS_MESSAGE, entries: list, shared: false }));
  if (shared.length) {
    void clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) c.postMessage({ type: REQUESTS_MESSAGE, entries: shared, shared: true });
    });
  }
};

watchWorkerRequests(tell);

// A page that opens asks for what it is owed: its own entries and the
// shared ones, newer than the newest helper row its tab's log already holds.
sw.addEventListener("message", (event) => {
  const data = event.data as { type?: string; after?: unknown } | null;
  if (data?.type !== REQUESTS_ASK) return;
  const source = (event as unknown as { source: Client | null }).source;
  if (!source) return;
  const after = typeof data.after === "number" && Number.isFinite(data.after) ? data.after : 0;
  const { own, shared } = answerFor(memory, source.id, after);
  if (own.length) source.postMessage({ type: REQUESTS_MESSAGE, entries: own, shared: false });
  if (shared.length) source.postMessage({ type: REQUESTS_MESSAGE, entries: shared, shared: true });
});
