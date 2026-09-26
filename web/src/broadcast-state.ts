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
