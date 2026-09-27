// The no-stall plan for a work made on this device (T7; design/spec.md 0.2;
// founder, 2026-09-26: "upfront wait is better than buffering lag"). Pure
// functions: no DOM, no clock, so every rule is held by tests.
//
// Speed is seconds of speech made per second of work on this device (the
// real-time factor), first from the speed test, then measured live from
// every line the device makes. Dial plans on 80% of it (PLANNING_MARGIN),
// because devices slow down as they warm up.
//
// The wait: playback starts once, from then on, every line will be made
// before the listener reaches it, at the planned speed; and never before the
// first MIN_LEAD_S seconds are made. Only speech takes making: the silence
// after a line is free. Lines not made yet are estimated from their words,
// scaled by how the made lines compared with their own estimates.

import { PLANNING_MARGIN } from "../bench";

export { PLANNING_MARGIN };

/** Playback never starts with less than this much made ahead of the listener. */
export const MIN_LEAD_S = 10;
/** Past this wait, the listener is offered a choice instead of waiting blindly. */
export const CHOICE_OVER_S = 120;
/** Weight of each new line's speed in the live measurement (design/spec.md 0.2: an exponential average, weight 0.3). */
export const LIVE_WEIGHT = 0.3;
/** Making ahead of the listener stops at the lower of an hour of audio or 150 MB of it as kept (16-bit, 24 kHz: 48,000 bytes a second). */
export const AHEAD_CAP_S = Math.min(60 * 60, 150_000_000 / 48_000);

/** One line of the work: its speech, the silence after it, and whether it is made (real lengths) or estimated. */
export interface PlanLine {
  speech: number;
  pause: number;
}

/**
 * Seconds to wait, from now, before playback may start at `position` (work
 * time) so that it never catches the making, at `rate` (the planned speed).
 * `made` lines are ready; the rest are made in order from now, the first of
 * them already `spent` seconds into its making. 0 when playback may start at
 * once. Infinity when nothing can be made (rate 0).
 */
export function leadWait(lines: readonly PlanLine[], made: number, position: number, rate: number, spent = 0): number {
  if (made >= lines.length) return 0;
  if (!(rate > 0) || !Number.isFinite(rate)) return Infinity;
  let at = 0;
  for (let i = 0; i < made; i++) at += lines[i]!.speech + lines[i]!.pause;
  let makingDone = 0;
  let wait = 0;
  for (let i = made; i < lines.length; i++) {
    const line = lines[i]!;
    // The line under way: what is left of it, and never less than a tenth (a line running late is late, not done).
    makingDone += i === made ? Math.max(0.1 * (line.speech / rate), line.speech / rate - Math.max(0, spent)) : line.speech / rate;
    // Line i must be made by the time playback reaches its start (after the wait) ...
    const reached = Math.max(0, at - position);
    wait = Math.max(wait, makingDone - reached);
    // ... and every line starting within the first MIN_LEAD_S is made before playback starts.
    if (at < position + MIN_LEAD_S) wait = Math.max(wait, makingDone);
    at += line.speech + line.pause;
  }
  return Math.max(0, wait);
}

/** The planned speed: 80% of the measured one. */
export function planRate(measured: number): number {
  return measured > 0 && Number.isFinite(measured) ? measured * PLANNING_MARGIN : 0;
}

/** The live measurement after one more line: its speed averaged in with weight LIVE_WEIGHT (the first line's replaces a speed that was never measured). */
export function nextRate(previous: number, speechSeconds: number, workSeconds: number): number {
  if (!(speechSeconds > 0) || !(workSeconds > 0)) return previous;
  const sample = speechSeconds / workSeconds;
  if (!(previous > 0)) return sample;
  return previous + LIVE_WEIGHT * (sample - previous);
}

/**
 * How the made lines' real speech compares with their estimates (1 until
 * one is made), so the lines not made yet are estimated at this voice's own
 * pace. Clamped to half and double, so one odd line cannot run the plan.
 */
export function paceScale(real: readonly number[], estimated: readonly number[]): number {
  let r = 0;
  let e = 0;
  for (let i = 0; i < real.length; i++) {
    if (real[i] === undefined || estimated[i] === undefined) continue;
    r += real[i]!;
    e += estimated[i]!;
  }
  if (!(r > 0) || !(e > 0)) return 1;
  return Math.max(0.5, Math.min(2, r / e));
}

export type Branch =
  /** A lead of MIN_LEAD_S or less: no countdown, the valve simply warms (design/spec.md 0.2). */
  | "short"
  /** Count down, then start: it will never pause. */
  | "countdown"
  /** Over two minutes: offer Dial's recording (where the work has one) or starting anyway. */
  | "choice";

export function branchFor(wait: number): Branch {
  if (!(wait > MIN_LEAD_S)) return "short";
  return wait > CHOICE_OVER_S ? "choice" : "countdown";
}

/**
 * The lines playback must have made before it starts again after a hold,
 * once the listener chose to start anyway: only the next MIN_LEAD_S, not the
 * whole no-stall lead (they accepted that it may pause).
 */
export function refillLines(lines: readonly PlanLine[], position: number): PlanLine[] {
  let at = 0;
  const out: PlanLine[] = [];
  for (const l of lines) {
    if (at >= position + MIN_LEAD_S) break;
    out.push(l);
    at += l.speech + l.pause;
  }
  return out;
}

/** The last line the device may make now: no further ahead of the listener than AHEAD_CAP_S (chapter-ahead within the memory cap). */
export function aheadLimit(lines: readonly PlanLine[], position: number, cap = AHEAD_CAP_S): number {
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    const end = at + lines[i]!.speech + lines[i]!.pause;
    if (end > position + cap) return Math.max(0, i - 1);
    at = end;
  }
  return lines.length - 1;
}
