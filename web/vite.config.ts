import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";

// The staged voice manifest's pins (scripts/fetch-voice.mjs), compiled into
// the page as __VOICE_PINS__ for its offline-compatibility key
// (src/offline/routes.ts offlineKey); scripts/build.mjs gives the offline
// helper the same pins. Null before the voice is staged.
const manifestPath = new URL("./public/voice/manifest.json", import.meta.url);
const pins = existsSync(manifestPath)
  ? (({ sha256, runtimeSha256, voices }) => ({ sha256, runtimeSha256, voices }))(JSON.parse(readFileSync(manifestPath, "utf8")))
  : null;

// Run with cwd set to web/ (scripts/build.mjs and scripts/dev.mjs both do
// this), so `root` defaults to this directory and `outDir` below lands at
// the repo root's dist/, matching wrangler.jsonc's assets.directory.
export default defineConfig({
  publicDir: "public",
  define: { __VOICE_PINS__: JSON.stringify(pins) },
  // The render worker (src/narrate.worker.ts) is an ES module: it imports
  // the voice runtime, which loads its WASM from /ort on this origin.
  worker: { format: "es" },
  // Dev only: the headers that let the runtime use threads, as _headers does in production.
  server: { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Fonts are always separate files, never inlined as data: URLs: the CSP
    // (scripts/lib/csp.mjs) allows fonts from this origin only.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
    rollupOptions: {
      input: {
        main: "index.html",
        privacy: "privacy.html",
      },
    },
  },
});
