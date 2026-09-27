// Dial's offline helper (a service worker), built by scripts/build.mjs into
// dist/sw.js with this build's tag and shell list. Its rules are the pure
// functions in offline/routes.ts. It answers this origin's own GET requests
// only, and makes only two kinds of request itself: the request the page
// made (to this origin, already under the page's CSP), and the shell's own
// paths, all on this origin (tests/offline.test.ts). It never sends anything.

import { OFFLINE_HEADER, SAVED_CACHE, isThisBuild, pageHeaders, route, shellCacheName, shellKey, staleShellCaches } from "./offline/routes";

declare const __BUILD_TAG__: string;
declare const __SHELL__: string[];

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
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
      if (path === "/" && !isThisBuild(await copy.clone().text(), __BUILD_TAG__)) throw new Error("/: another build");
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
  if (data?.type === "ensure-shell") event.waitUntil(precache().then((ok) => port.postMessage({ type: "shell", ok, build: __BUILD_TAG__ })));
  else if (data?.type === "shell-status") event.waitUntil(shellComplete().then((ok) => port.postMessage({ type: "shell", ok, build: __BUILD_TAG__ })));
});

async function fromShell(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreSearch: true });
  return hit ?? fetch(request);
}

async function page(request: Request): Promise<Response> {
  try {
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

async function saved(request: Request): Promise<Response> {
  const key = new URL(request.url).pathname;
  const cache = await caches.open(SAVED_CACHE);
  try {
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
  event.respondWith(r === "page" ? page(request) : r === "saved" ? saved(request) : fromShell(request));
});
