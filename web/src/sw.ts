// Dial's offline helper (a service worker), built by scripts/build.mjs into
// dist/sw.js with this build's tag and shell list. Its rules are the pure
// functions in offline/routes.ts. It answers this origin's own GET requests
// only, and makes only two kinds of request itself: the request the page
// made (to this origin, already under the page's CSP), and the shell's own
// paths, all on this origin (tests/offline.test.ts). It never sends anything.

import { SAVED_CACHE, pageHeaders, route, shellCacheName, shellKey, staleShellCaches } from "./offline/routes";

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

/** Keeps every shell path not yet kept. True when the whole shell is in place. */
async function precache(): Promise<boolean> {
  const cache = await caches.open(SHELL);
  let ok = true;
  for (const path of __SHELL__) {
    if (await cache.match(path)) continue;
    try {
      const res = await fetch(path, { cache: "reload" });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      await cache.put(path, await clean(res));
    } catch {
      ok = false;
    }
  }
  return ok;
}

sw.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const stale of staleShellCaches(await caches.keys(), __BUILD_TAG__)) await caches.delete(stale);
      await sw.clients.claim();
    })(),
  );
});

// "Save for offline" asks for the whole shell before it says a work is saved.
sw.addEventListener("message", (event) => {
  const data = event.data as { type?: string } | null;
  const port = event.ports[0];
  if (data?.type !== "ensure-shell" || !port) return;
  event.waitUntil(precache().then((ok) => port.postMessage({ type: "shell", ok, build: __BUILD_TAG__ })));
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

async function saved(request: Request): Promise<Response> {
  const key = new URL(request.url).pathname;
  const cache = await caches.open(SAVED_CACHE);
  try {
    const res = await fetch(request);
    // Refresh a saved copy (a new release's manifest); never save what the listener did not.
    if (res.ok && (await cache.match(key))) await cache.put(key, res.clone());
    return res;
  } catch {
    return (await cache.match(key)) ?? Response.error();
  }
}

sw.addEventListener("fetch", (event) => {
  const request = event.request;
  const r = route(new URL(request.url), request.method, sw.location.origin, request.mode);
  if (r === "ignore") return;
  event.respondWith(r === "page" ? page(request) : r === "saved" ? saved(request) : fromShell(request));
});
