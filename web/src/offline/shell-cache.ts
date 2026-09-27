// The offline helper's shell cache, as functions of a CacheStorage and a
// fetch, so the order of events around an update (install, a save through
// the old helper, activate, offline) can be run in a test with a fake cache
// (tests/offline-update.test.ts). web/src/sw.ts wires them to the real ones.
//
// The rule it keeps: once a work is saved, a whole shell stays on the
// device. A first visit keeps only the core (scripts/lib/shell.mjs
// coreShellPaths); a new helper that activates while a work is saved first
// completes its own shell, and if it cannot (offline), it keeps the older
// builds' shells, and a file its own shell lacks is answered from them.

import { SAVED_CACHE, SHELL_CACHE_PREFIX, isPage, isThisBuild, shellCacheName, staleShellCaches } from "./routes";

/** The parts of CacheStorage the helper uses. */
export interface CacheStorageLike {
  open(name: string): Promise<Cache>;
  has(name: string): Promise<boolean>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export interface ShellBuild {
  tag: string;
  /** Every shell path of this build. */
  shell: readonly string[];
  /** Fetches one shell path from this origin, past the HTTP cache (sw.ts BUILD). */
  get: (path: string) => Promise<Response>;
}

/** A cacheable copy: a redirected response is stored as its final page, since a page cannot be answered with a redirect it followed. */
async function clean(res: Response): Promise<Response> {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Keeps every path in `paths` not yet kept in this build's shell. True only
 * when all of them are in place. A page is kept only if it is this build's
 * (its <meta name="build"> is the tag), so a shell never mixes two releases.
 */
export async function precache(caches: CacheStorageLike, b: ShellBuild, paths: readonly string[]): Promise<boolean> {
  const cache = await caches.open(shellCacheName(b.tag));
  let ok = true;
  for (const path of paths) {
    if (await cache.match(path)) continue;
    try {
      const res = await b.get(path);
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      const copy = await clean(res);
      // Every page kept must be this build's, never another release's.
      if (isPage(copy.headers.get("content-type")) && !isThisBuild(await copy.clone().text(), b.tag)) throw new Error(`${path}: another build`);
      await cache.put(path, copy);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** Whether every shell path of this build is kept. */
export async function shellComplete(caches: CacheStorageLike, b: Pick<ShellBuild, "tag" | "shell">): Promise<boolean> {
  const cache = await caches.open(shellCacheName(b.tag));
  for (const path of b.shell) if (!(await cache.match(path))) return false;
  return true;
}

/** Whether a work is saved on this device (its text is in the saved cache). Opens no cache that does not exist. */
export async function anySaved(caches: CacheStorageLike): Promise<boolean> {
  if (!(await caches.has(SAVED_CACHE))) return false;
  const saved = await caches.open(SAVED_CACHE);
  return (await saved.keys()).some((r) => new URL(r.url).pathname.startsWith("/works/"));
}

/**
 * On activate: where a work is saved, this build's shell is completed first
 * (a work may have been saved through the previous helper after this one
 * installed its core). Only a complete shell, or no saved work, lets the
 * older builds' shells go; otherwise they stay, for shellMatch to fall
 * back on. Returns whether the older shells were deleted.
 */
export async function activateShell(caches: CacheStorageLike, b: ShellBuild): Promise<boolean> {
  if ((await anySaved(caches)) && !(await shellComplete(caches, b)) && !(await precache(caches, b, b.shell))) return false;
  for (const stale of staleShellCaches(await caches.keys(), b.tag)) await caches.delete(stale);
  return true;
}

/**
 * A shell file from this build's shell, else from any older build's shell
 * still kept (activateShell keeps them while this one is incomplete), else
 * undefined. The same hashed file name means the same bytes.
 */
export async function shellMatch(caches: CacheStorageLike, tag: string, request: Request): Promise<Response | undefined> {
  const own = await (await caches.open(shellCacheName(tag))).match(request, { ignoreSearch: true });
  if (own) return own;
  for (const name of await caches.keys()) {
    if (!name.startsWith(SHELL_CACHE_PREFIX) || name === shellCacheName(tag)) continue;
    const hit = await (await caches.open(name)).match(request, { ignoreSearch: true });
    if (hit) return hit;
  }
  return undefined;
}
