// The offline helper's rules (web/src/sw.ts), kept pure so tests can hold
// them without a browser. The service worker answers only this origin's own
// GET requests (Law 1); everything else, including every other origin, it
// leaves to the browser untouched, under the page's CSP.
//
// - The app shell (pages, scripts, styles, fonts, the app manifest and
//   icons) is kept in one cache per build, named for the build tag. A new
//   release installs a new worker with a new cache; the old ones are
//   deleted when it activates.
// - A work saved for offline, and the two small voice files an offline
//   Tune in needs from the network (the voice manifest and the runtime's
//   .mjs), sit in the saved cache, which only "Save for offline" fills and
//   "Remove" empties (offline/store.ts). The helper reads it when the
//   network fails and refreshes an entry already there; it never adds one.
// - The Worker's routes (/e, /feedback, /healthz, /api/) are never
//   answered or cached here: offline, they fail as they would with no helper.

import { PAGE_CSP_HEADER, SECURITY_HEADERS } from "../../../scripts/lib/csp.mjs";
import { shellKey, shellPaths } from "../../../scripts/lib/shell.mjs";

export { shellKey, shellPaths };

export const SHELL_CACHE_PREFIX = "dial-shell-";
/** Works saved for offline, with the voice manifest and runtime script an offline Tune in fetches. */
export const SAVED_CACHE = "dial-saved";

/** Set by the helper on every saved-route response it answers, so a probe can tell it is in the path. */
export const OFFLINE_HEADER = "x-dial-offline-helper";

/** Whether a page is this build's: its <meta name="build"> content is the tag. */
export function isThisBuild(html: string, buildTag: string): boolean {
  const m = /<meta\s+name="build"\s+content="([^"]*)"/i.exec(html);
  return !!m && m[1] === buildTag;
}

/** The shell cache for one build. */
export function shellCacheName(buildTag: string): string {
  return `${SHELL_CACHE_PREFIX}${buildTag}`;
}

/** Every shell cache but this build's: deleted when this build's helper activates. */
export function staleShellCaches(names: readonly string[], buildTag: string): string[] {
  const current = shellCacheName(buildTag);
  return names.filter((n) => n.startsWith(SHELL_CACHE_PREFIX) && n !== current);
}

/** Paths the helper never answers, so never caches: the Worker's own routes and the helper's script. */
export const NEVER_CACHED = ["/e", "/feedback", "/healthz", "/api/", "/sw.js"] as const;

export function isNeverCached(pathname: string): boolean {
  return NEVER_CACHED.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));
}

/**
 * - ignore: not answered; the browser fetches it as if there were no helper.
 * - page: a page; the network first (so a release shows at once), the shell cache when offline.
 * - shell: a hashed script, style, font, icon or the app manifest; the shell cache first.
 * - saved: a work's text, the voice manifest or the runtime's script; the network first, the saved cache when offline.
 */
export type Route = "ignore" | "page" | "shell" | "saved";

/** Where a request is answered from. `origin` is the helper's own. */
export function route(url: URL, method: string, origin: string, mode?: string): Route {
  if (method !== "GET" || url.origin !== origin) return "ignore";
  const p = url.pathname;
  if (isNeverCached(p)) return "ignore";
  if (/^\/works\/[a-z0-9-]+\.txt$/.test(p) || p === "/voice/manifest.json" || /^\/ort\/[^/]+\.mjs$/.test(p)) return "saved";
  // The model's parts, the voices and the runtime's .wasm are kept by the page itself (voice.ts, offline/store.ts).
  if (p.startsWith("/voice/") || p.startsWith("/ort/") || p.startsWith("/works/")) return "ignore";
  if (mode === "navigate" || p === "/" || p.endsWith(".html") || p === "/privacy") return "page";
  return "shell";
}

/**
 * A page's headers as served from the cache: the security headers and the
 * policy from scripts/lib/csp.mjs, so a page the helper answers offline is
 * still cross-origin isolated (COOP and COEP), framed by no one, and under
 * the same CSP as when it came from the network.
 */
export function pageHeaders(from: Headers): Headers {
  const h = new Headers(from);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  h.set("Content-Security-Policy", PAGE_CSP_HEADER);
  return h;
}
