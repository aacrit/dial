#!/usr/bin/env node
// The no-scroll rule in a real browser (design/spec.md 00, "Test rule for
// T8"): loads the built site at each viewport of the panel map and fails if
// the page is wider than the viewport or any part of a panel ends outside
// it. The rule itself is scripts/lib/layout-probe.mjs (unit-tested in
// tests/panels.test.ts); this script only drives a browser.
//
// It is the product's browser suite, run before a merge (the /ship rule),
// never in the per-commit gate: it needs Playwright and a browser, which
// Dial does not depend on. It uses the `playwright` package if node_modules
// has it, else the folder named by DIAL_PLAYWRIGHT (a playwright install
// elsewhere on the machine). With neither it says so and exits 2.
//
//   npm run build && npm run layout-check [-- --port 8803] [--shots <dir>] [--url <base>]
//
// Without --url it serves dist/ itself on 127.0.0.1 (static files only: /e
// and /feedback answer 404), so nothing leaves the machine; the offline
// helper runs, so Save for offline is on the page as a listener sees it.
// "On air" is a layout stub: the parts a broadcast shows are revealed with
// the longest status line, without making any speech.

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge, measure } from "./lib/layout-probe.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repoRoot, "dist");

/** The panel map's viewports (web/src/panels.ts VIEWPORTS; tests/panels.test.ts keeps them equal). */
export const VIEWPORTS = [
  [375, 812],
  [768, 1024],
  [1280, 800],
  [1280, 720],
  [1920, 1080],
  [740, 360],
];

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const where of ["playwright", process.env.DIAL_PLAYWRIGHT].filter(Boolean)) {
    try {
      return require(where);
    } catch {
      // Not here; try the next place.
    }
  }
  return null;
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml" };

/** dist/ as Workers Static Assets serves it: /play/crito is play/crito.html, anything else missing is a 404. */
function serveDist(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    let file = path.join(dist, rel);
    if (!file.startsWith(dist)) file = "";
    if (file && !existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!file || req.method !== "GET" || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** Reveals what a broadcast shows, as long as it can be: a layout stub, no speech is made. */
function stubOnAir() {
  document.body.dataset.onAir = "true";
  for (const id of ["ribbon-box", "pause", "readalong", "download", "render-meter"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("tune-in", "On air");
  set("broadcast-status", "Getting the voice ready: 48.2 of 114.6 MB. It downloads once from dial.voidvision.org, then stays on this device. The voice could not be kept on this device, so it will download again next time.");
  set("broadcast-progress", "Crito: line 12 of 118 heard, 40 made.");
  set("t-el", "01:27");
  set("t-total", "about 20:12");
  set("scrub-note", "Only lines 1 to 40 of 118 are made so far.");
  const ra = document.getElementById("ra-lines");
  const live = ra?.querySelector(".ra.live");
  if (live && !live.textContent) live.textContent = "Why have you come at this hour, Crito? it must be quite early.";
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw) {
    console.error("layout-check: Playwright is not installed here. Install it (npm i -D playwright) or set DIAL_PLAYWRIGHT to a playwright folder; nothing was checked.");
    process.exit(2);
  }
  const base = arg("--url");
  const port = Number(arg("--port") ?? 8803);
  const shots = arg("--shots");
  if (shots) mkdirSync(shots, { recursive: true });
  if (!base && !existsSync(path.join(dist, "index.html"))) {
    console.error("layout-check: dist/ is not built. Run npm run build first.");
    process.exit(2);
  }
  const server = base ? null : await serveDist(port);
  const origin = base ?? `http://127.0.0.1:${port}`;
  const browser = await pw.chromium.launch();
  const rows = [];
  try {
    for (const [width, height] of VIEWPORTS) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
      const page = await context.newPage();
      // One panel with everything on it (web/src/panels.ts SINGLE_PANEL): both halves are in view.
      const single = width >= 1600 && height >= 900;
      const inView = (id) => (single ? ["radio", "work"] : [id]);
      const check = async (scenario, id) => {
        const m = await page.evaluate(measure, inView(id));
        const v = judge(m);
        rows.push({ viewport: `${width}x${height}`, scenario, scrollWidth: `${m.scrollWidth}/${m.innerWidth}`, worst: v.worst, ok: v.ok, problems: v.problems });
        if (shots) await page.screenshot({ path: path.join(shots, `${scenario.replace(/\W+/g, "-")}-${width}x${height}.png`) });
      };
      /** Presses a control as a listener would; one that is covered or off the panel is a failure of its own. */
      const press = async (selector, scenario) => {
        try {
          await page.locator(selector).click({ timeout: 3000 });
          await page.waitForTimeout(150);
          return true;
        } catch (err) {
          const lines = String(err instanceof Error ? err.message : err).split("\n");
          const why = lines.find((l) => l.includes("intercepts")) ?? lines[0];
          rows.push({ viewport: `${width}x${height}`, scenario, scrollWidth: "-", worst: 0, ok: false, problems: [`${selector} could not be pressed: ${why.trim()}`] });
          return false;
        }
      };
      const toPanel = async (id, scenario) => (single ? true : press(`#band button[data-to="${id}"]`, scenario));

      // The radio, idle, once the stations are read.
      await page.goto(`${origin}/`);
      await page.waitForSelector('[data-device][data-state="ready"]', { timeout: 15_000 });
      await page.waitForTimeout(200);
      await check("radio", "radio");
      if (await toPanel("work", "work")) {
        await check("work", "work");
        if (await press("#seal-reqs > summary", "seal open")) {
          await check("seal open", "work");
          await press("#seal-reqs > summary", "seal close");
        }
        if (await press("#tab-script", "script")) {
          await check("script", "work");
          if (await page.locator("#text-close").isVisible()) await press("#text-close", "script close");
        }
      }

      // A work's Broadcast, on air (stubbed).
      await page.goto(`${origin}/play/crito`);
      await page.waitForSelector('[data-device][data-state="ready"]', { timeout: 15_000 });
      await page.evaluate(stubOnAir);
      await page.waitForTimeout(200);
      await check("on air", "radio");
      if (await toPanel("work", "on air work")) await check("on air work", "work");
      await context.close();
    }
  } finally {
    await browser.close();
    server?.close();
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad("viewport", 11)}${pad("scenario", 13)}${pad("scrollWidth", 13)}${pad("worst px", 10)}result`);
  for (const r of rows) console.log(`${pad(r.viewport, 11)}${pad(r.scenario, 13)}${pad(r.scrollWidth, 13)}${pad(r.worst.toFixed(1), 10)}${r.ok ? "PASS" : "FAIL"}`);
  const failed = rows.filter((r) => !r.ok);
  for (const r of failed) console.log(`\n${r.viewport} ${r.scenario}:\n  - ${r.problems.join("\n  - ")}`);
  console.log(`\nlayout-check: ${rows.length - failed.length} of ${rows.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
