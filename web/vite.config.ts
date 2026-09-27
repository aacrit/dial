import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
// @ts-expect-error: a plain .mjs helper without type declarations
import { voiceTable } from "../scripts/lib/voice-table.mjs";
import { WORKS } from "./src/catalogue";
import { playPageHtml } from "./src/route";

/**
 * Each work's Broadcast address, /play/<slug>, is a real static page:
 * dist/play/<slug>.html, made from the built index.html (the same entry,
 * the same hashed scripts and styles) with the work's title. Workers Static
 * Assets serves it at /play/<slug>, so a reload or a shared link works, and
 * scripts/build.mjs stamps and polices it like every other page.
 */
function playPages(): Plugin {
  let outDir = "";
  return {
    name: "dial-play-pages",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const index = readFileSync(path.join(outDir, "index.html"), "utf8");
      mkdirSync(path.join(outDir, "play"), { recursive: true });
      for (const w of WORKS) writeFileSync(path.join(outDir, "play", `${w.slug}.html`), playPageHtml(index, w));
    },
  };
}

// Run with cwd set to web/ (scripts/build.mjs and scripts/dev.mjs both do
// this), so `root` defaults to this directory and `outDir` below lands at
// the repo root's dist/, matching wrangler.jsonc's assets.directory.
export default defineConfig({
  publicDir: "public",
  // Casting's voice table, projected to the fields it reads (engine/cast.ts).
  plugins: [voiceTable(), playPages()],
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
        seal: "seal.html",
      },
    },
  },
});
