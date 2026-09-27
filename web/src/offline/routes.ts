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

/** Whether a response is a page (and so must be this build's): by its content type. */
export function isPage(contentType: string | null): boolean {
  return !!contentType && contentType.toLowerCase().includes("text/html");
}

/** Whether a page is this build's: its <meta name="build"> content is the tag. */
export function isThisBuild(html: string, buildTag: string): boolean {
  const m = /<meta\s+name="build"\s+content="([^"]*)"/i.exec(html);
  return !!m && m[1] === buildTag;
}

/** The pins an offline render depends on: the model's, the runtime's and each voice's. */
export interface VoicePinSet {
  sha256: string;
  runtimeSha256: string;
  voices: Record<string, string>;
}

/** The pins from a voice manifest (scripts/fetch-voice.mjs writes it), or null. */
export function pinsOf(m: unknown): VoicePinSet | null {
  const x = m as Partial<VoicePinSet> | null;
  if (!x || typeof x.sha256 !== "string" || typeof x.runtimeSha256 !== "string" || !x.voices || typeof x.voices !== "object") return null;
  return { sha256: x.sha256, runtimeSha256: x.runtimeSha256, voices: x.voices };
}

/**
 * The offline-compatibility key: a hash (FNV-1a, 32 bit) of the voice pins,
 * the casting rule's version and the prepared recordings' pins (each work's
 * timing index SHA-256; none, and the key is what it was before T5). The helper compiles its build's key in
 * (sw.ts); the page compiles its own (vite.config.ts). A work shows "Saved"
 * only when the two match: then the helper that answers offline serves the
 * same voice and the same cast the page would use. Null pins give no key.
 */
export function offlineKey(pins: VoicePinSet | null, castVersion: string, recordings: Readonly<Record<string, string>> = {}): string | null {
  if (!pins) return null;
  const voices = Object.keys(pins.voices)
    .sort()
    .map((id) => `${id}=${pins.voices[id]}`)
    .join(",");
  const recorded = Object.keys(recordings)
    .sort()
    .map((slug) => `${slug}=${recordings[slug]}`)
    .join(",");
  const text = `model=${pins.sha256};runtime=${pins.runtimeSha256};voices=${voices};cast=${castVersion}${recorded ? `;recordings=${recorded}` : ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The page's offline key: the voice pins it read (the site's online, the
 * saved copy offline), and the recordings' pins compiled into it at build
 * (recording/source.ts BUILT_RECORDINGS), never a fetched list. So the key
 * is the same online and offline, and whether or not this browser can play
 * the recordings, as the helper's is.
 */
export function pageOfflineKey(pins: VoicePinSet | null, castVersion: string, built: { works: Readonly<Record<string, { index: string }>> }): string | null {
  return offlineKey(pins, castVersion, Object.fromEntries(Object.entries(built.works).map(([slug, w]) => [slug, w.index])));
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
 * - saved: a work's text, the voice manifest, the runtime's script or a prepared recording's files; the network first, the saved cache when offline.
 */
export type Route = "ignore" | "page" | "shell" | "saved";

/** Where a request is answered from. `origin` is the helper's own. */
export function route(url: URL, method: string, origin: string, mode?: string): Route {
  if (method !== "GET" || url.origin !== origin) return "ignore";
  const p = url.pathname;
  if (isNeverCached(p)) return "ignore";
  if (/^\/works\/[a-z0-9-]+\.txt$/.test(p) || p === "/voice/manifest.json" || /^\/ort\/[^/]+\.mjs$/.test(p)) return "saved";
  // A prepared recording: the list, each work's index and parts. Kept only when the listener saves the work.
  if (p === "/recordings/manifest.json" || /^\/recordings\/[a-z0-9-]+\/(index\.json|part\d+\.webm)$/.test(p)) return "saved";
  // The model's parts, the voices and the runtime's .wasm are kept by the page itself (voice.ts, offline/store.ts).
  if (p.startsWith("/voice/") || p.startsWith("/ort/") || p.startsWith("/works/") || p.startsWith("/recordings/")) return "ignore";
  // A work's Broadcast, /play/<slug>, is a page like the home page (T3).
  if (mode === "navigate" || p === "/" || p.endsWith(".html") || p === "/privacy" || p.startsWith("/play/")) return "page";
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
