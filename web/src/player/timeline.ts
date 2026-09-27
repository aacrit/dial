// The Broadcast's clock, as pure functions: where each line sits in the
// work's own time, which line a moment belongs to, how far a seek may go
// (only into what has been made), and the J/K/L and [ ] steps. No audio and
// no DOM here, so tests hold every rule without a browser.
//
// Work time runs from 0 at the first word. A line's length is its speech
// plus the silence after it (the pause table), exactly as the WAV lays it
// out (engine/wav.ts), so a position here is a position in the file.

import { WORDS_PER_MINUTE, countWords } from "../catalogue";

/** Where each line starts in work time, from the lines' lengths (speech plus the silence after). */
export function lineStarts(lengths: readonly number[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const d of lengths) {
    out.push(at);
    at += d;
  }
  return out;
}

/** The line a moment belongs to: the last one starting at or before it (0 before the first). */
export function lineAt(starts: readonly number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Seconds of the work made so far: the sum of the made lines' lengths. */
export function madeSeconds(lengths: readonly number[]): number {
  let s = 0;
  for (const d of lengths) s += d;
  return s;
}

/**
 * The work's running time for the progress strip: the made lines' real
 * lengths, and for the rest an estimate (words at 155 a minute plus the
 * pause table, as the Repertory's "about 20 min"). `exact` once every line
 * is made; until then the strip says "about".
 */
export function runningTime(cues: readonly { spoken: string; pauseAfterMs: number }[], lengths: readonly number[]): { seconds: number; exact: boolean } {
  let seconds = 0;
  for (let i = 0; i < cues.length; i++) seconds += lengths[i] ?? estimateLine(cues[i]!);
  return { seconds, exact: lengths.length >= cues.length };
}

/** One line's estimated length before it is made: its words at 155 a minute, plus its silence. */
export function estimateLine(cue: { spoken: string; pauseAfterMs: number }): number {
  return (countWords(cue.spoken) / WORDS_PER_MINUTE) * 60 + cue.pauseAfterMs / 1000;
}

/** [ and ]: the line before or after `current`, kept within the lines made (and never before the first). */
export function lineStep(current: number, delta: -1 | 1, made: number): number | null {
  if (made <= 0) return null;
  const next = Math.max(0, Math.min(made - 1, Math.max(0, current) + delta));
  return next === current ? null : next;
}

/** J and L jump 10 seconds; pressed again within this window, the jump doubles (1×, 2×, 4×). */
export const SCRUB_BASE_S = 10;
export const SCRUB_REPEAT_MS = 1200;
export const SCRUB_MAX_MULTIPLIER = 4;

export interface ScrubState {
  /** -1 for J (back), 1 for L (forward), 0 after K or at rest. */
  direction: -1 | 0 | 1;
  multiplier: number;
  at: number;
}

export const SCRUB_REST: ScrubState = { direction: 0, multiplier: 1, at: -Infinity };

/** One press of J (-1) or L (1) at `now` (ms): the seconds to move, and the state for the next press. */
export function scrubPress(prev: ScrubState, direction: -1 | 1, now: number): { seconds: number; next: ScrubState } {
  const again = prev.direction === direction && now - prev.at <= SCRUB_REPEAT_MS;
  const multiplier = again ? Math.min(SCRUB_MAX_MULTIPLIER, prev.multiplier * 2) : 1;
  return { seconds: direction * SCRUB_BASE_S * multiplier, next: { direction, multiplier, at: now } };
}

/**
 * Where a released drag on the strip lands: the start of the made line
 * nearest to `t` (design/spec.md 3: releasing lands on the nearest line
 * start). Past what is made it is left as it is, for the seek to judge.
 */
export function nearestLineStart(starts: readonly number[], made: number, t: number): number {
  if (starts.length === 0 || t >= made) return t;
  let best = starts[0]!;
  for (const s of starts) if (Math.abs(s - t) < Math.abs(best - t)) best = s;
  return best;
}
