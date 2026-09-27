// The offline helper's app shell: which built files it keeps, and the key a
// page is kept under. Plain JavaScript so the build (scripts/build.mjs)
// can compute the list, and the helper (web/src/sw.ts, through
// web/src/offline/routes.ts) uses the same rule at run time.

/** The key a page is kept under: "/" for the home page, "/privacy" for the privacy page. */
export function shellKey(pathname) {
  const p = pathname.replace(/\.html$/, "");
  return p === "/index" || p === "" ? "/" : p.replace(/\/index$/, "/");
}

/**
 * Build output that is never part of the shell: the voice, the texts, Dial's
 * prepared recordings (kept only when a listener saves a work), the
 * helper itself, files Workers Static Assets never serves, and any .wasm
 * (the runtime's 21.6 MB .wasm is kept by the voice loader, keyed to its
 * pin, and handed to the runtime, which then never fetches a bundled copy).
 */
const NOT_SHELL = [/^voice\//, /^ort\//, /^works\//, /^recordings\//, /^_headers$/, /^_redirects$/, /^offline-shell\.json$/, /^build-tag\.txt$/, /^sw\.js$/, /\.map$/, /\.wasm$/];

/**
 * The shell's paths from the build's file list (paths relative to dist/,
 * "/" separated): every page by its shellKey, every other file by its path.
 * Only this origin's own paths: each starts with a single "/".
 */
export function shellPaths(distFiles) {
  const out = new Set();
  for (const f of distFiles) {
    if (NOT_SHELL.some((re) => re.test(f))) continue;
    out.add(f.endsWith(".html") ? shellKey(`/${f}`) : `/${f}`);
  }
  return [...out].sort();
}

/**
 * Shell files a first visit does not need to open the pages offline: the
 * render worker's script (about 2.2 MB, used only to make speech on the
 * device) and the fonts' extended-Latin faces (used only for letters the
 * works rarely have). They are kept with the rest of the shell as soon as a
 * listener saves a work (the helper's ensure-shell), or at install when a
 * work is already saved.
 */
const LATER = [/^\/assets\/narrate\.worker-[^/]*\.js$/, /-latin-ext-[^/]*\.woff2$/];

/** The shell every visitor's helper keeps at install (the pre-Proof audit: about 0.6 MB, not 3 MB). */
export function coreShellPaths(shell) {
  return shell.filter((p) => !LATER.some((re) => re.test(p)));
}
