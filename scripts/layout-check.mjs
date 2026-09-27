#!/usr/bin/env node
// The no-scroll rule in a real browser (design/spec.md 00, "Test rule for
// T8"; CoS decisions F and G, 2026-09-27): loads the built site at the panel
// map's six viewports and six smaller ones, walks every state a listener
// can reach (the radio, offline, the work panel, the Seal's list open and
// scrolled, the Script and the Bookplate, the feedback sheet, on air), and
// fails if anything is wider than the viewport, anything is out of reach,
// or, at the map's own viewports, any part fails to fit its panel. The rule
// itself is scripts/lib/layout-probe.mjs (unit-tested in
// tests/panels.test.ts); this script drives a browser and checks focus and
// scrolling where only a browser can.
//
// It is a gate step (decision G): CI installs Playwright's Chromium and runs
// it on every pull request. Locally, `npm run gate` passes --gate, which
// skips with a clear message when no browser can start; CI never skips.
//
//   npm run build && npm run layout-check [-- --port 8803] [--shots <dir>] [--url <base>] [--only 740x360]
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

/** The panel map's viewports, where every part must fit (web/src/panels.ts VIEWPORTS; tests/panels.test.ts keeps them equal). */
export const VIEWPORTS = [
  [375, 812],
  [768, 1024],
  [1280, 800],
  [1280, 720],
  [1920, 1080],
  [740, 360],
];

/** Smaller and in-between screens, where a panel may scroll inside itself but nothing may be out of reach (web/src/panels.ts SMALL_VIEWPORTS). */
export const SMALL_VIEWPORTS = [
  [375, 667],
  [360, 640],
  [320, 568],
  [640, 360],
  [960, 540],
  [568, 320],
];

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function loadPlaywright() {
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
  set("ra-who", "On air: Crito");
  set("broadcast-status", "Getting the voice ready: 48.2 of 114.6 MB. It downloads once from dial.voidvision.org, then stays on this device. The voice could not be kept on this device, so it will download again next time.");
  set("broadcast-progress", "Crito: line 12 of 118 heard, 40 made.");
  set("t-el", "01:27");
  set("t-total", "about 20:12");
  set("scrub-note", "Only lines 1 to 40 of 118 are made so far.");
}

/** Dial's recording stopped mid-listen: Resume and the make-it-here link both under Tune in, with the error line. A layout stub. */
function stubStopped() {
  for (const id of ["resume-line", "make-here", "retry"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("resume-line", "Resume at line 64");
  const status = document.getElementById("broadcast-status");
  if (status) {
    status.dataset.state = "error";
    status.textContent = "Dial's recording stopped at line 64: this browser could not play the next part. Resume, and it carries on from line 64 as the same listen.";
  }
}

/** The work panel's widgets the open Seal overlaps that could still take focus (not inert). Runs in the page. */
function coveredNotInert() {
  const seal = document.getElementById("seal")?.getBoundingClientRect();
  if (!seal) return [];
  return [...document.querySelectorAll("#widgets > .widget:not(.w-seal)")]
    .filter((w) => {
      const r = w.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const across = Math.min(r.right, seal.right) - Math.max(r.left, seal.left);
      const down = Math.min(r.bottom, seal.bottom) - Math.max(r.top, seal.top);
      return across > 1 && down > 1 && !w.inert;
    })
    .map((w) => (w.id ? `#${w.id}` : `.${w.className.split(" ").join(".")}`));
}

/** Where focus is, and whether it can be seen: its panel is the band's current one, and it is on screen. */
function focusState() {
  const el = document.activeElement;
  const r = el ? el.getBoundingClientRect() : null;
  const panel = el?.closest("[data-panel]")?.id ?? null;
  const current = document.querySelector('#band button[aria-current="true"]')?.getAttribute("data-to") ?? null;
  const onScreen = !!r && r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  return { id: el?.id ?? "", panel, current, onScreen };
}

/** Whether `--only` (a "<width>x<height>" string) names a checked viewport; no --only checks them all. */
export function onlyMatches(only) {
  return only === undefined || [...VIEWPORTS, ...SMALL_VIEWPORTS].some(([w, h]) => `${w}x${h}` === only);
}

async function main() {
  // --only that names no checked viewport would check nothing: a failure, never a pass (T8 review).
  const only = arg("--only");
  if (!onlyMatches(only)) {
    const known = [...VIEWPORTS, ...SMALL_VIEWPORTS].map(([w, h]) => `${w}x${h}`).join(", ");
    console.error(`layout-check: --only ${only} matches no viewport (${known}); nothing was checked.`);
    process.exit(1);
  }
  const gate = process.argv.includes("--gate");
  const skip = (why) => {
    // In CI the check always runs (decision G); a local gate may lack a browser.
    if (gate && !process.env.CI) {
      console.log(`layout-check: SKIPPED here: ${why}. CI runs it on every pull request; run npx playwright install chromium to run it locally.`);
      process.exit(0);
    }
    console.error(`layout-check: ${why}; nothing was checked.`);
    process.exit(2);
  };
  const pw = loadPlaywright();
  if (!pw) skip("Playwright is not installed (npm install, or set DIAL_PLAYWRIGHT to a playwright folder)");
  const base = arg("--url");
  const port = Number(arg("--port") ?? 8803);
  const shots = arg("--shots");
  if (shots) mkdirSync(shots, { recursive: true });
  if (!base && !existsSync(path.join(dist, "index.html"))) {
    console.error("layout-check: dist/ is not built. Run npm run build first.");
    process.exit(2);
  }
  let browser;
  try {
    browser = await pw.chromium.launch();
  } catch (err) {
    skip(`Chromium would not start (${String(err instanceof Error ? err.message : err).split("\n")[0]})`);
  }
  const server = base ? null : await serveDist(port);
  const origin = base ?? `http://127.0.0.1:${port}`;
  const rows = [];
  try {
    for (const [width, height, fit] of [...VIEWPORTS.map((v) => [...v, true]), ...SMALL_VIEWPORTS.map((v) => [...v, false])]) {
      if (only && only !== `${width}x${height}`) continue;
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
      const page = await context.newPage();
      const viewport = `${width}x${height}`;
      // One panel with everything on it (web/src/panels.ts SINGLE_PANEL): both halves are in view.
      const single = width >= 1600 && height >= 900;
      const inView = (id) => (single ? ["radio", "work"] : [id]);
      const fail = (scenario, problem) => rows.push({ viewport, scenario, scrollWidth: "-", worst: 0, clipped: 0, ok: false, problems: [problem] });
      const check = async (scenario, roots, extra = []) => {
        const m = await page.evaluate(measure, roots);
        const v = judge(m, { fit });
        const problems = [...v.problems, ...extra];
        rows.push({ viewport, scenario, scrollWidth: `${m.scrollWidth}/${m.innerWidth}`, worst: v.worst, clipped: v.clipped, ok: problems.length === 0, problems });
        if (shots) await page.screenshot({ path: path.join(shots, `${scenario.replace(/\W+/g, "-")}-${viewport}.png`) });
      };
      /** Presses a control as a listener would; one that is covered or off the panel is a failure of its own. */
      const press = async (selector, scenario) => {
        try {
          await page.locator(selector).click({ timeout: 3000 });
          await page.waitForTimeout(150);
          return true;
        } catch (err) {
          const lines = String(err instanceof Error ? err.message : err).split("\n");
          fail(scenario, `${selector} could not be pressed: ${(lines.find((l) => l.includes("intercepts")) ?? lines[0]).trim()}`);
          return false;
        }
      };
      const toPanel = async (id, scenario) => (single ? true : press(`#band button[data-to="${id}"]`, scenario));
      /** After Esc: focus is back on `id`, on screen, in the panel the band shows. */
      const focusBack = async (id) => {
        await page.waitForTimeout(200);
        const f = await page.evaluate(focusState);
        const out = [];
        if (f.id !== id) out.push(`focus went to #${f.id || "(body)"}, not #${id}`);
        if (!f.onScreen) out.push(`focus on #${f.id} is off screen`);
        if (!single && f.panel && f.current !== f.panel) out.push(`the band shows ${f.current} while focus is on the ${f.panel} panel`);
        return out;
      };

      // The radio, idle, once the stations are read.
      await page.goto(`${origin}/`);
      await page.waitForSelector('[data-device][data-state="ready"]', { timeout: 15_000 });
      await page.waitForTimeout(250);
      await check("radio", inView("radio"));
      // The connection drops: the offline notice joins the device's side.
      await context.setOffline(true);
      await page.waitForTimeout(300);
      await check("offline", inView("radio"));
      await context.setOffline(false);
      await page.waitForTimeout(300);
      // The read-along's Script key opens the script on the work panel (filling it on a phone); Esc brings focus home.
      if (await press("#open-script", "script from the radio")) {
        if (await page.locator("#text-close").isVisible()) {
          await check("script filled", inView("work"));
          await page.keyboard.press("Escape");
          const back = await focusBack("open-script");
          if (back.length) fail("script from the radio", back.join("; "));
        } else if (!single) await press('#band button[data-to="radio"]', "back to the radio");
      }
      if (await toPanel("work", "work")) {
        await check("work", inView("work"));
        // The Seal's list: open, and it scrolls inside itself.
        if (await press("#seal-reqs > summary", "seal open")) {
          // Whatever the open Seal covers is inert: nothing under it can take focus (T8 review).
          const underSeal = await page.evaluate(coveredNotInert);
          await check("seal open", inView("work"), underSeal.map((w) => `${w} sits under the open Seal but is not inert`));
          const reqs = page.locator(".reqs");
          const before = await reqs.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, top: el.scrollTop }));
          const box = await reqs.boundingBox();
          const extra = [];
          if (!(before.sh > before.ch)) extra.push(`the request list shows everything at once (scrollHeight ${before.sh}, clientHeight ${before.ch}); it should hold more than it shows`);
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 40));
            await page.mouse.wheel(0, 400);
            await page.waitForTimeout(250);
          }
          const after = await reqs.evaluate((el) => el.scrollTop);
          if (!(after > before.top)) extra.push(`the request list did not scroll under the wheel (scrollTop ${before.top} to ${after})`);
          if (!box || box.height < 24) extra.push(`the request list is ${box ? box.height.toFixed(0) : 0} px tall`);
          await check("seal scrolled", inView("work"), extra);
          await press("#seal-reqs > summary", "seal close");
        }
        for (const [tab, scenario] of [
          ["#tab-script", "script"],
          ["#tab-bookplate", "bookplate"],
        ]) {
          if (!(await press(tab, scenario))) continue;
          await check(scenario, inView("work"));
          if (await page.locator("#text-close").isVisible()) {
            await page.keyboard.press("Escape");
            const back = await focusBack(tab.slice(1));
            if (back.length) fail(`${scenario} close`, back.join("; "));
          }
        }
        // The feedback sheet: it fits, and closing it hands focus back on screen.
        if (await press("#open-feedback", "feedback")) {
          await check("feedback", ["feedback-sheet"]);
          await page.keyboard.press("Escape");
          const back = await focusBack("open-feedback");
          if (back.length) fail("feedback close", back.join("; "));
        }
      }

      // A work's Broadcast, on air (stubbed).
      await page.goto(`${origin}/play/crito`);
      await page.waitForSelector('[data-device][data-state="ready"]', { timeout: 15_000 });
      await page.evaluate(stubOnAir);
      await page.waitForTimeout(250);
      await check("on air", inView("radio"));
      if (await toPanel("work", "on air work")) await check("on air work", inView("work"));
      // Dial's recording stopped: Resume and the make-it-here link together under Tune in.
      await page.goto(`${origin}/play/crito`);
      await page.waitForSelector('[data-device][data-state="ready"]', { timeout: 15_000 });
      await page.evaluate(stubStopped);
      await page.waitForTimeout(200);
      await check("stopped", inView("radio"));
      await context.close();
    }
  } finally {
    await browser.close();
    server?.close();
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad("viewport", 11)}${pad("scenario", 23)}${pad("scrollWidth", 13)}${pad("clipped", 9)}${pad("worst px", 10)}result`);
  for (const r of rows) console.log(`${pad(r.viewport, 11)}${pad(r.scenario, 23)}${pad(r.scrollWidth, 13)}${pad(r.clipped, 9)}${pad(r.worst.toFixed(1), 10)}${r.ok ? "PASS" : "FAIL"}`);
  const failed = rows.filter((r) => !r.ok);
  for (const r of failed) console.log(`\n${r.viewport} ${r.scenario}:\n  - ${r.problems.slice(0, 12).join("\n  - ")}${r.problems.length > 12 ? `\n  - and ${r.problems.length - 12} more` : ""}`);
  const clipped = rows.reduce((n, r) => n + r.clipped, 0);
  console.log(`\nlayout-check: ${rows.length - failed.length} of ${rows.length} passed at ${VIEWPORTS.length + SMALL_VIEWPORTS.length} viewports; ${clipped} clipped`);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
