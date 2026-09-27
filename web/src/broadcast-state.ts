// The broadcast's rules as pure functions, so tests can hold them without a
// browser: when the tally lamp is lit, which line is live, when a work
// counts as opened.

export interface LampInput {
  /** The broadcast has not been stopped or finished. */
  live: boolean;
  /** Its audio is playing (not paused). */
  playing: boolean;
  /** Every line has been made. */
  renderDone: boolean;
}

/**
 * Tally means a render or playback is live (design/spec.md 1.1). So the lamp
 * stays lit while lines are still being made even if playback is paused,
 * and goes out when both have stopped.
 */
export function lampLit(s: LampInput | null): boolean {
  return !!s && s.live && (s.playing || !s.renderDone);
}

/** The line playing at `now`: the last one whose start has passed, or -1 before the first. */
export function liveLine(starts: readonly (number | undefined)[], now: number): number {
  let current = -1;
  starts.forEach((t, i) => {
    if (t !== undefined && t <= now) current = i;
  });
  return current;
}

/**
 * `work_opened` is sent once per station per page load: true the first time
 * a slug is seen (and records it), false after. The first station the page
 * lands on is not counted; the listener choosing a station, or pressing
 * Tune in on it, is.
 */
export function firstOpen(opened: Set<string>, slug: string): boolean {
  if (opened.has(slug)) return false;
  opened.add(slug);
  return true;
}

/** The download's file name: "dial-514-002-crito.wav". */
export function wavName(station: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `dial-514-${station}-${slug}.wav`;
}

/** Where a broadcast's audio comes from: Dial's prepared recording, or made on this device. */
export type ListenKind = "prepared" | "made";

/** Share of a work's running time a listener must hear for the listen to count (CoS decision A, 2026-09-27). */
export const HEARD_SHARE = 0.8;

/**
 * The seconds heard between two readings of the listener's place: the
 * advance of their place in the work, but only where it moved as the audio
 * clock did. A seek (a jump further than the clock moved, or backwards)
 * and a pause (the clock stopped) add nothing. `slack` absorbs rounding
 * between the clock and the schedule.
 */
export function heardStep(prevPos: number, pos: number, clockDelta: number, slack = 0.25): number {
  if (!(clockDelta > 0)) return 0;
  const d = pos - prevPos;
  if (!(d > 0) || d > clockDelta + slack) return 0;
  return d;
}

/** Per line, the stretches of it heard so far (seconds into the line, merged). */
export type HeardSpans = Map<number, [number, number][]>;

function spanTotal(spans: readonly [number, number][]): number {
  return spans.reduce((n, [a, b]) => n + (b - a), 0);
}

/**
 * Adds [from, to) of work time, just heard, to the lines it covers (CoS
 * decision C: heard means distinct line time). A line's time counts once:
 * a replay of a stretch already heard adds nothing. Lines before
 * `silentBelow` (the recording's lines seeded on this device without their
 * audio) never count. Returns the seconds newly heard.
 */
export function addHeard(spans: HeardSpans, at: readonly number[], lengths: readonly number[], from: number, to: number, silentBelow = 0): number {
  if (!(to > from) || at.length === 0) return 0;
  let added = 0;
  let i = 0;
  while (i + 1 < at.length && at[i + 1]! <= from) i++;
  for (; i < at.length && at[i]! < to; i++) {
    if (i < silentBelow || lengths[i] === undefined) continue;
    const s = Math.max(from, at[i]!) - at[i]!;
    const e = Math.min(to, at[i]! + lengths[i]!) - at[i]!;
    if (!(e > s)) continue;
    const had = spans.get(i) ?? [];
    const before = spanTotal(had);
    const merged: [number, number][] = [];
    for (const [a, b] of [...had, [s, e] as [number, number]].sort((x, y) => x[0] - y[0])) {
      const last = merged.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    spans.set(i, merged);
    added += spanTotal(merged) - before;
  }
  return added;
}

/**
 * chapter_rendered, the success event, once per listen, on either path
 * (Dial's prepared recording or made on this device): when the listener
 * has heard at least HEARD_SHARE of the work's running time, counted as
 * audio played, never as audio seeked over. `sent`: this listen already counted.
 */
export function countsAsListen(heardSeconds: number, totalSeconds: number, sent: boolean): boolean {
  return !sent && totalSeconds > 0 && heardSeconds >= HEARD_SHARE * totalSeconds;
}
