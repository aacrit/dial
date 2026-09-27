// T9 review, blocking finding 1: a saved work must stay playable offline
// across an update. The order that broke it: the new helper (v2) installs
// only the core shell while nothing is saved; the listener then saves a work
// through the old helper (v1), which keeps its whole shell; v2 activates and
// deleted v1's shell, and with it the render worker's script. These tests
// run that order against a fake CacheStorage (web/src/offline/shell-cache.ts
// is what web/src/sw.ts runs).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SAVED_CACHE, shellCacheName } from "../web/src/offline/routes";
import { activateShell, anySaved, precache, shellComplete, shellMatch, type CacheStorageLike, type ShellBuild } from "../web/src/offline/shell-cache";
import { coreShellPaths } from "../scripts/lib/shell.mjs";

const ORIGIN = "https://dial.test";
const abs = (p: string) => new URL(p, ORIGIN).toString();
const keyOf = (r: RequestInfo | URL) => new URL(typeof r === "string" ? r : r instanceof URL ? r.href : r.url, ORIGIN).pathname;

/** An in-memory Cache: keys by path, answers clones. */
class FakeCache {
  entries = new Map<string, Response>();
  async match(r: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(keyOf(r))?.clone();
  }
  async put(r: RequestInfo | URL, res: Response): Promise<void> {
    this.entries.set(keyOf(r), res.clone());
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((p) => new Request(abs(p)));
  }
}

class FakeCaches implements CacheStorageLike {
  stores = new Map<string, FakeCache>();
  async open(name: string): Promise<Cache> {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name) as unknown as Cache;
  }
  async has(name: string) {
    return this.stores.has(name);
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

const SHELL = ["/", "/assets/main-a.js", "/assets/narrate.worker-b.js", "/privacy"];
let online = true;
/** A build as its server answers it: its pages carry its tag; nothing answers offline. */
const build = (tag: string): ShellBuild => ({
  tag,
  shell: SHELL,
  get: async (p) => {
    if (!online) throw new TypeError("fetch failed");
    const page = p === "/" || p === "/privacy";
    return new Response(page ? `<meta name="build" content="${tag}" />` : `// ${p} of ${tag}`, { headers: { "content-type": page ? "text/html" : "text/javascript" } });
  },
});
const WORKER = "/assets/narrate.worker-b.js";

/** The listener saves a work through `helper`: its ensure-shell, then the work's text in the saved cache. */
async function saveThrough(caches: FakeCaches, helper: ShellBuild) {
  expect(await precache(caches, helper, helper.shell)).toBe(true);
  await (await caches.open(SAVED_CACHE)).put(abs("/works/cave.txt"), new Response("text"));
}

describe("a saved work stays playable offline across an update", () => {
  it("the failing order, offline at activate: v2 keeps v1's shell and serves the render worker from it", async () => {
    online = true;
    const caches = new FakeCaches();
    const v1 = build("v1");
    const v2 = build("v2");
    // v1 is in control with its core; v2 installs its core while nothing is saved.
    expect(await precache(caches, v1, coreShellPaths(SHELL))).toBe(true);
    expect(await anySaved(caches)).toBe(false);
    expect(await precache(caches, v2, coreShellPaths(SHELL))).toBe(true);
    // The listener saves a work through v1 (the page's ensure-shell reached only the controller).
    await saveThrough(caches, v1);
    // The connection drops; v2 activates.
    online = false;
    expect(await activateShell(caches, v2)).toBe(false);
    // v2's own shell cannot hold the worker, so v1's is kept, and the worker is answered from it.
    expect(await shellComplete(caches, v2)).toBe(false);
    expect(await caches.has(shellCacheName("v1"))).toBe(true);
    const res = await shellMatch(caches, "v2", new Request(abs(WORKER)));
    expect(res).toBeDefined();
    expect(await res!.text()).toBe(`// ${WORKER} of v1`);
    // v2's own files still come from v2's shell.
    expect(await (await shellMatch(caches, "v2", new Request(abs("/"))))!.text()).toContain('content="v2"');
    // Back online, the next activation completes v2 and lets v1's shell go.
    online = true;
    expect(await activateShell(caches, v2)).toBe(true);
    expect(await caches.has(shellCacheName("v1"))).toBe(false);
    expect(await (await shellMatch(caches, "v2", new Request(abs(WORKER))))!.text()).toBe(`// ${WORKER} of v2`);
  });

  it("the same order online: v2 completes its own shell before deleting v1's", async () => {
    online = true;
    const caches = new FakeCaches();
    const v1 = build("v1");
    const v2 = build("v2");
    await precache(caches, v1, coreShellPaths(SHELL));
    await precache(caches, v2, coreShellPaths(SHELL));
    await saveThrough(caches, v1);
    expect(await activateShell(caches, v2)).toBe(true);
    expect(await shellComplete(caches, v2)).toBe(true);
    expect([...(await caches.keys())].filter((n) => n.startsWith("dial-shell-"))).toEqual([shellCacheName("v2")]);
    expect(await (await shellMatch(caches, "v2", new Request(abs(WORKER))))!.text()).toBe(`// ${WORKER} of v2`);
  });

  it("with nothing saved, activate deletes the old shells at once and needs no network", async () => {
    online = false;
    const caches = new FakeCaches();
    await (await caches.open(shellCacheName("v1"))).put(abs("/"), new Response("old"));
    await (await caches.open(shellCacheName("v2"))).put(abs("/"), new Response("new"));
    expect(await activateShell(caches, build("v2"))).toBe(true);
    expect(await caches.keys()).toEqual([shellCacheName("v2")]);
    // A file no shell holds is not invented.
    expect(await shellMatch(caches, "v2", new Request(abs(WORKER)))).toBeUndefined();
  });

  it("the helper runs these, and the page asks a waiting helper too when a work is saved", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const sw = readFileSync(path.join(root, "web/src/sw.ts"), "utf8");
    expect(sw).toMatch(/await activateShell\(caches, BUILD\);\s*await sw\.clients\.claim\(\);/);
    expect(sw).toContain("const hit = await shellMatch(caches, __BUILD_TAG__, request);");
    expect(sw).not.toMatch(/staleShellCaches/);
    const store = readFileSync(path.join(root, "web/src/offline/store.ts"), "utf8");
    expect(store).toMatch(/Promise\.all\(\[askHelper\("ensure-shell", timeoutMs\), ask\(await waitingHelper\(\), "ensure-shell", timeoutMs\)\]\)/);
    expect(store).toContain("return (await container.getRegistration())?.waiting ?? null;");
  });
});
