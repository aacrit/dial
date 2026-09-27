// The Seal, as a widget on the radio's work panel (design/spec.md 00; it
// replaced the /seal page on 2026-09-27). A small magic eye, one plain
// sentence, today's counts from this tab, the counts switch, and "Show every
// request" collapsed. Everything it says comes from this tab's request log
// (request-recorder.ts) and the switch (telemetry.ts). It sends nothing of its
// own, and counts nothing. The speed test moved out with the page: it
// belongs to the radio's gauge (T7), whose engine is bench.ts and the
// render worker's "bench".

import { eyePath } from "./device/needle";
import { motion } from "./device/reduced-motion";
import { PRESETS, Spring } from "./device/spring";
import { countLineHtml, countsToday, footHtml, isSealed, logRowsHtml, requestsIntroHtml, sealLineHtml, summarize, totalsHtml } from "./request-log";
import { readLog, recordRequests } from "./request-recorder";
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
    if (svg.dataset.state === state) return;
    svg.dataset.state = state;
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

// ---- the sentence, today's counts and the request list ------------------

function setupWords(): void {
  const line = $("seal-line");
  const count = $("seal-count");
  const intro = $("seal-reqs-intro");
  const rows = $("log");
  const tot = $("log-tot");
  const foot = $("log-foot");
  const svg = document.getElementById("seal-eye") as SVGSVGElement | null;
  const fan = document.getElementById("seal-fan") as SVGPathElement | null;
  if (!line || !count || !intro || !rows || !tot || !foot || !svg || !fan) return;
  const eye = mountEye(svg, fan);

  let shown = "";
  let ready = typeof PerformanceObserver !== "function";
  const render = () => {
    const log = readLog();
    const s = summarize(log.records);
    const sealed = isSealed(log.records);
    line.innerHTML = sealLineHtml(s, sealed, ready, location.host);
    count.innerHTML = countLineHtml(countsToday(log.records, Date.now(), log.dropped), countsOn() ? "on" : "off");
    intro.innerHTML = requestsIntroHtml(s, sealed, location.host);
    tot.innerHTML = totalsHtml(s);
    const html = logRowsHtml(log.records);
    if (html !== shown) {
      rows.innerHTML = html;
      shown = html;
    }
    foot.innerHTML = footHtml(sealed, log.dropped);
    eye(!ready ? "reading" : sealed ? "sealed" : "open");
  };
  // "Reading this tab" until the browser hands over its first batch of the
  // record; then every change repaints. A browser without the record API
  // shows what the tab's log already holds.
  recordRequests(() => {
    ready = true;
    requestAnimationFrame(render);
  });
  render();
  // The switch changes the count line; midnight changes what "today" is,
  // looked at once a minute while the tab is in view, and on coming back.
  document.addEventListener("dial:counts", render);
  setInterval(() => {
    if (!document.hidden) render();
  }, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) render();
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

/** Mounts the Seal widget. It sends no count of its own. */
export function mountSealWidget(): void {
  for (const el of document.querySelectorAll("[data-host]")) el.textContent = location.host;
  setupWords();
  setupSwitch();
}
