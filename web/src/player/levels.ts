// The analyser-to-meter mapping, as pure functions (design/spec.md 3, "The
// VU pair"): the Voice meter's height is loudness on a dBFS scale from 0 to
// -40, and its hue is the live line's register, switched by hard cut. The
// samples come from one AnalyserNode on the broadcast's own AudioContext:
// they are read in this tab and go nowhere else.

/** The meter's floor: -40 dBFS reads as empty. */
export const FLOOR_DBFS = -40;
/** The in-range band the Voice meter marks (design/spec.md 3). */
export const BAND_DBFS = [-23, -18] as const;

/** Root mean square of a block of samples (-1 to 1). No allocation: it reads the caller's buffer. */
export function rms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sum += s * s;
  }
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Loudness in dBFS from an RMS level, floored at the meter's floor. */
export function toDbfs(level: number): number {
  if (!(level > 0)) return FLOOR_DBFS;
  return Math.max(FLOOR_DBFS, Math.min(0, 20 * Math.log10(level)));
}

/** The meter's height, 0 (at or below -40 dBFS) to 1 (0 dBFS), linear in dB. */
export function loudnessToHeight(dbfs: number): number {
  return Math.max(0, Math.min(1, (dbfs - FLOOR_DBFS) / -FLOOR_DBFS));
}

/** Whether a loudness sits in the band ("Voice level in range"). */
export function inBand(dbfs: number): boolean {
  return dbfs >= BAND_DBFS[0] && dbfs <= BAND_DBFS[1];
}

/** Where the band's edges sit on the meter, as shares of its width (for the marks drawn on it). */
export function bandMarks(): [number, number] {
  return [loudnessToHeight(BAND_DBFS[0]), loudnessToHeight(BAND_DBFS[1])];
}

export type Register = "telling" | "speaking" | "letter";

/**
 * A line's register, from form only (Law 3): a line with a speaker (its own
 * label, or a turn it continues) is speaking; any other line is the
 * narrator's telling. Letter and verse wait for F1's rules, so nothing is
 * given that register yet.
 */
export function registerOf(cue: { speaker?: string } | undefined): Register {
  return cue?.speaker ? "speaking" : "telling";
}

/** The colour token a register's meter uses: design/tokens.css is the only place the colour itself lives. */
export function registerToken(register: Register): string {
  return `--color-glass-reg-${register}`;
}

/** The Music meter: Dial has no music yet, so it rests at zero and says so. */
export const MUSIC_NONE = "Music: none in this work yet";
