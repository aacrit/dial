// "Speed of this device", as pure functions: the one sentence the test
// times, the speed it measures and its words. The test left with the Seal
// page (T8, design/spec.md 00): it becomes the radio's gauge in T7, which
// has a slot on the glass (index.html #speed-gauge) and wires the 80%
// planning margin (founder, 2026-09-26) into the radio. Nothing here or in
// narrate.worker.ts's bench() sends anything, not even a count
// (tests/seal.test.ts checks both).

import { aboutMegabytes, isStatableTotal } from "./download-size";
import { esc } from "./render";
import type { Need } from "./voice-cache";

/** The fixed sentence the test speaks (bench-sentence.ts). */
export { BENCH_SENTENCE } from "./bench-sentence";

/** Dial plans on this share of the measured speed: devices slow down as they warm up. */
export const PLANNING_MARGIN = 0.8;

/** Speed as a multiple of real time: seconds of speech made per second of work. */
export function speedOf(audioSeconds: number, workMs: number): number {
  if (!(audioSeconds > 0) || !(workMs > 0)) return 0;
  return audioSeconds / (workMs / 1000);
}

export function plannedSpeed(speed: number): number {
  return speed * PLANNING_MARGIN;
}

/** "1.1×", "0.88×": two decimals below 1, one at or above. */
export function speedLabel(x: number): string {
  // 0.996 would read "1.00×" with two decimals: at 1 it is shown as "1.0×", like any speed from 1 up.
  const two = x.toFixed(2);
  return `${x < 1 && two !== "1.00" ? two : x.toFixed(1)}×`;
}

/** "3.4 s", "850 ms". */
export function secondsLabel(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const num = (s: string) => `<span data-numeral>${esc(s)}</span>`;

/** What the browser reports for free, before any test: its processor threads. */
export function reportsHtml(threads: number | undefined): string {
  if (!threads || !Number.isFinite(threads)) return "This browser does not report its processor threads.";
  return `This browser reports ${num(String(threads))} processor ${threads === 1 ? "thread" : "threads"}.`;
}

export interface BenchResult {
  /** From pressing the button to the voice ready: download (first time only) and loading into memory. */
  loadMs: number;
  /** The first sentence's making time. */
  firstMs: number;
  /** Seconds of speech the sentence made. */
  audioSeconds: number;
}

/** The processor column's figures: threads, isolation, voice load and first sentence. */
export function cpuDetailsHtml(threads: number | undefined, isolated: boolean, r?: BenchResult): string {
  const rows: [string, string][] = [
    ["Threads", threads && Number.isFinite(threads) ? num(String(threads)) : "not reported"],
    ["Cross-origin isolated", isolated ? "Yes" : "No"],
  ];
  if (r) {
    rows.push(["Voice load", num(secondsLabel(r.loadMs))]);
    rows.push(["First sentence", num(secondsLabel(r.firstMs))]);
  }
  return rows.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${dd}</dd>`).join("");
}

/** The verdict under the results: the measured speed only (the planning margin reaches the copy with T7). */
export function verdictHtml(speed: number): string {
  const label = speedLabel(speed);
  // Faster or slower is read from the figure shown, so the words never disagree with it.
  const shown = Number(label.slice(0, -1));
  const pace = shown === 1 ? "as fast as real time" : shown > 1 ? "faster than real time" : "slower than real time";
  return `<b>Dial will use the processor: ${num(label)}, ${pace}.</b>`;
}

/** Before the test: whether it uses the voice already here, or what it downloads first (the radio's size rules). */
export function benchNeedLine(total: unknown, need: Need | null, missingVoices = 1): string {
  // A presence-only look (voice-files.ts voicePresence): the files are there, not yet checked against their pins.
  if (need === "none") return "The voice looks to be on this device already.";
  if (!need || !isStatableTotal(total)) return "The test downloads the voice first if it is not on this device.";
  if (need === "voices") return `The test adds its ${missingVoices === 1 ? "voice" : "voices"} to this device first (${aboutMegabytes(total)}).`;
  return `The test downloads the voice once (${aboutMegabytes(total)}) and keeps it on this device.`;
}

/** The gauge (viewBox 120 x 64): 0 to 4× across the arc, the needle at `x`, real time marked. */
export function gaugeSvg(x: number): string {
  const clamped = Math.max(0, Math.min(4, Number.isFinite(x) ? x : 0));
  const deg = (-60 + clamped * 30).toFixed(1);
  return (
    `<svg class="gauge" viewBox="0 0 120 64" aria-hidden="true">` +
    `<path class="g-arc" d="M21.9 34 A44 44 0 0 1 98.1 34"/>` +
    `<path class="g-slow" d="M21.9 34 A44 44 0 0 1 38 17.9"/>` +
    `<line class="g-tk" x1="21.9" y1="34" x2="27.1" y2="37"/>` +
    `<line class="g-tk rt" x1="38" y1="17.9" x2="41" y2="23.1"/>` +
    `<line class="g-tk" x1="60" y1="12" x2="60" y2="18"/>` +
    `<line class="g-tk" x1="82" y1="17.9" x2="79" y2="23.1"/>` +
    `<line class="g-tk" x1="98.1" y1="34" x2="92.9" y2="37"/>` +
    `<text class="g-lb" x="15" y="44">0</text><text class="g-lb" x="33" y="13">1×</text><text class="g-lb" x="60" y="8">2</text>` +
    `<text class="g-lb" x="87" y="13">3</text><text class="g-lb" x="105" y="44">4</text>` +
    `<line class="g-nd" x1="60" y1="56" x2="60" y2="18" transform="rotate(${deg} 60 56)"/>` +
    `<circle class="g-cap" cx="60" cy="56" r="3.5"/></svg>`
  );
}

/** The processor column's gauge and big figure. */
export function speedHtml(speed: number): string {
  return `${gaugeSvg(speed)}<span class="big">${num(speedLabel(speed))}<small> real time</small></span>`;
}

/** Plain words for a test that stopped, from the worker's "<name>: <message>". Browser text is never shown. */
export function benchStopLine(raw: string): string {
  if (/QuotaExceeded|quota|no room|out of (storage|space)/i.test(raw)) return "This device is out of storage for the voice. Free some space, then run the test again.";
  if (/: \d{3}$/.test(raw)) return "Dial could not send the voice. Try again later.";
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(raw)) return "Could not reach Dial. Check your connection, then run the test again.";
  return "The test stopped unexpectedly. Run it again to retry.";
}
