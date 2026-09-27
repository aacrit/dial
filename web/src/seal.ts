// The Seal at /seal: the magic eye, the request log, the counts switch and
// the speed of this device. The log reads this tab's record
// (request-recorder.ts); the switch is telemetry.ts's; the speed test runs
// in the render worker (narrate.worker.ts, "bench") and its results stay on this screen, never sent.

import { benchNeedLine, benchStopLine, cpuDetailsHtml, reportsHtml, speedHtml, speedOf, verdictHtml } from "./bench";
import type { FromBench, ToWorker } from "./narrate.worker";
import { eyePath } from "./device/needle";
import { watchReducedMotion, motion } from "./device/reduced-motion";
import { PRESETS, Spring } from "./device/spring";
import { isStatableTotal, warmingLine } from "./download-size";
import { NARRATORS } from "./engine/cast";
import { esc } from "./render";
import { voicePresence } from "./voice-files";
import { footHtml, isSealed, logRowsHtml, sealWords, summarize, totalsHtml } from "./request-log";
import { readLog, recordEntries, recordRequests } from "./request-recorder";
import { STORAGE_REFUSED, canKeepSetting, countsOn, setCounts } from "./telemetry";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

// ---- the magic eye: open and dim while reading, a hairline once sealed ----

/** Wedge angles: reading, sealed, and open (a request to another address). */
const WEDGE = { reading: 80, sealed: 4, open: 110 } as const;

function mountEye(svg: SVGSVGElement, fan: SVGPathElement) {
  const wedge = new Spring(PRESETS.warm, WEDGE.reading);
  let frame = 0;
  let last = 0;
  const draw = () => fan.setAttribute("d", eyePath(wedge.x));
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    wedge.step(dt, motion.reduce);
    draw();
    frame = wedge.resting ? 0 : requestAnimationFrame(loop);
  };
  draw();
  return (state: keyof typeof WEDGE) => {
    svg.dataset.state = state;
    svg.setAttribute(
      "aria-label",
      state === "sealed" ? "The magic eye, closed: sealed." : state === "open" ? "The magic eye, open: a request went to another address." : "The magic eye, open while the page reads this tab's record.",
    );
    wedge.to(WEDGE[state]);
    if (motion.reduce) {
      wedge.snap();
      draw();
      return;
    }
    if (!frame) {
      last = performance.now();
      frame = requestAnimationFrame(loop);
    }
  };
}

// ---- the log and the headline --------------------------------------------

function setupLog(): void {
  const h1 = $("seal-h");
  const say = $("seal-say");
  const rows = $("log");
  const tot = $("log-tot");
  const foot = $("log-foot");
  const svg = document.getElementById("meye") as SVGSVGElement | null;
  const fan = document.getElementById("fan") as SVGPathElement | null;
  if (!h1 || !say || !rows || !tot || !foot || !svg || !fan) return;
  for (const el of document.querySelectorAll("[data-host]")) el.textContent = location.host;
  const eye = mountEye(svg, fan);

  let shown = "";
  const render = () => {
    const log = readLog();
    const s = summarize(log.records);
    const sealed = isSealed(log.records);
    const words = sealWords(s, sealed, countsOn() ? "on" : "off", location.host, log.dropped);
    if (h1.textContent !== words.headline) h1.textContent = words.headline;
    say.innerHTML = words.say;
    tot.innerHTML = totalsHtml(s);
    const html = logRowsHtml(log.records);
    if (html !== shown) {
      rows.innerHTML = html;
      shown = html;
    }
    foot.innerHTML = footHtml(sealed, log.dropped);
    eye(sealed ? "sealed" : "open");
    // A blocked request opens the limits drill: it explains where such a request comes from.
    if (s.blocked) $("limits")?.setAttribute("open", "");
  };
  // "Reading this tab" until the browser hands over its first batch of the
  // record; then every change repaints. A browser without the record API
  // shows what the tab's log already holds.
  let ready = typeof PerformanceObserver !== "function";
  recordRequests(() => {
    ready = true;
    requestAnimationFrame(render);
  });
  if (ready) render();
  // The switch changes the sentence.
  document.addEventListener("dial:counts", () => {
    if (ready) render();
  });
}

// ---- the counts switch -----------------------------------------------------

function setupSwitch(): void {
  const sw = $<HTMLButtonElement>("sw");
  const note = $("sw-note");
  if (!sw || !note) return;
  const paint = () => sw.setAttribute("aria-checked", String(countsOn()));
  /** The browser will not keep the setting: the switch cannot work, so it is disabled and says why. */
  const refuse = () => {
    sw.disabled = true;
    note.textContent = STORAGE_REFUSED;
  };
  paint();
  if (!canKeepSetting()) refuse();
  sw.addEventListener("click", () => {
    const on = !countsOn();
    const kept = setCounts(on);
    paint();
    if (!kept) refuse();
    document.dispatchEvent(new Event("dial:counts"));
  });
  // Another tab changed it.
  addEventListener("storage", () => {
    paint();
    document.dispatchEvent(new Event("dial:counts"));
  });
}

// ---- the speed of this device (processor only; the graphics chip is T7) -----

function setupBench(): void {
  const run = $<HTMLButtonElement>("bench-run");
  const reports = $("bench-reports");
  const cpu = $("bench-cpu");
  const cpuD = $("bench-cpu-d");
  const status = $("bench-status");
  const verdict = $("bench-verdict");
  const note = $("bench-note");
  const needLine = $("bench-need");
  if (!run || !reports || !cpu || !cpuD || !status || !verdict || !note || !needLine) return;
  // Before the click: what the test will download, from what is present on
  // this device (voice-files.ts voicePresence: no hashing, no new caches).
  const checkNeed = () =>
    voicePresence([NARRATORS.m])
      .then((n) => (needLine.textContent = benchNeedLine(n.bytes, n.need, n.missingVoices)))
      .catch(() => (needLine.textContent = benchNeedLine(null, null)));
  void checkNeed();
  const threads = navigator.hardwareConcurrency;
  const isolated = globalThis.crossOriginIsolated === true;
  reports.innerHTML = reportsHtml(threads);
  cpuD.innerHTML = cpuDetailsHtml(threads, isolated);

  let worker: Worker | null = null;
  const stop = () => {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    worker = null;
    run.disabled = false;
  };

  run.addEventListener("click", () => {
    if (worker) return;
    const began = performance.now();
    let loadMs = 0;
    let warmingStated = false;
    run.disabled = true;
    verdict.hidden = true;
    status.textContent = "Warming the voice.";
    needLine.textContent = "";
    const w = new Worker(new URL("./narrate.worker.ts", import.meta.url), { type: "module" });
    worker = w;
    w.onmessage = (event: MessageEvent<FromBench>) => {
      const msg = event.data;
      if (msg.type === "requests") return recordEntries(msg.entries);
      if (worker !== w) return;
      if (msg.type === "loading") {
        if (!warmingStated) {
          warmingStated = true;
          status.textContent = warmingLine(msg.total, msg.need, "the test", msg.missingVoices);
        }
        if (isStatableTotal(msg.total) && msg.need !== "none") {
          const mb = (n: number) => `<span data-numeral>${esc((n / 1_000_000).toFixed(1))}</span>`;
          cpu.innerHTML = `<p class="none">Voice: ${mb(Math.min(msg.loaded, msg.total))} of ${mb(msg.total)} MB</p>`;
        }
      } else if (msg.type === "timing") {
        loadMs = performance.now() - began;
        cpu.innerHTML = `<p class="none">Timing&hellip;</p>`;
        status.textContent = "Timing one short sentence on the processor…";
      } else if (msg.type === "result") {
        stop();
        const speed = speedOf(msg.audioSeconds, msg.firstMs);
        cpu.innerHTML = speedHtml(speed);
        cpuD.innerHTML = cpuDetailsHtml(threads, isolated, { loadMs, firstMs: msg.firstMs, audioSeconds: msg.audioSeconds });
        verdict.innerHTML = verdictHtml(speed);
        verdict.hidden = false;
        note.hidden = false;
        status.textContent = "Done. The results are on this screen only.";
        run.textContent = "Run it again";
        void checkNeed();
      } else {
        stop();
        cpu.innerHTML = `<p class="none">Not measured.</p>`;
        status.textContent = benchStopLine(msg.message);
        void checkNeed();
      }
    };
    w.onerror = (event) => {
      event.preventDefault();
      stop();
      cpu.innerHTML = `<p class="none">Not measured.</p>`;
      status.textContent = benchStopLine(event.message || "");
      void checkNeed();
    };
    w.postMessage({ type: "bench" } satisfies ToWorker);
  });
}

// The Seal sends no count of its own, not even a page view: it only reads
// the tab's record, and the switch here governs Dial's other pages.
watchReducedMotion();
recordRequests();
setupLog();
setupSwitch();
setupBench();
