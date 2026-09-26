// The dial's geometry and the needle's rules, as pure functions (no DOM):
// where a station sits, which station a released needle lands on, how close
// the needle is to one (the tuning eye and, from T3, the wave's convergence).
//
// Provenance: the alignment idea is tweaked from sadhana's
// frontend/app/components/TanpuraViz.tsx (at sadhana a121809): there, lines
// converge as the voice's pitch aligns with Sa; here alignment is the
// needle's proximity to a station. Its Sa/Pa ratios, colours and fixed
// 0.016 s step are left behind. The geometry follows the approved mock
// (design/mocks/repertory.html).

/** The scale's half-width: the arc runs from -68 to +68 degrees (136 in all). */
export const MAX_ANGLE = 68;

/** Seconds of the release speed the landing is projected ahead (design/spec.md 0.1). */
export const FLING_LOOKAHEAD_S = 0.16;

/** Within this many degrees of a station, the needle counts as near it. */
export const ALIGN_WIDTH_DEG = 9;

/** SVG geometry of the dial window (viewBox 0 0 400 250). */
export const DIAL = { cx: 200, cy: 236, r: 176 } as const;

export function clampAngle(a: number): number {
  return Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, a));
}

/** Index of the station nearest an angle. */
export function nearestStation(angles: readonly number[], a: number): number {
  let best = 0;
  angles.forEach((s, i) => {
    if (Math.abs(s - a) < Math.abs(angles[best]! - a)) best = i;
  });
  return best;
}

/** Where a released (possibly flung) needle comes to rest: its position projected ahead by its speed, snapped to a station. */
export function landing(angles: readonly number[], x: number, v: number): number {
  return nearestStation(angles, clampAngle(x + v * FLING_LOOKAHEAD_S));
}

/** 1 on a station, falling to 0 at ALIGN_WIDTH_DEG away from every station. */
export function alignment(angles: readonly number[], a: number): number {
  let best = 0;
  for (const s of angles) best = Math.max(best, 1 - Math.min(1, Math.abs(a - s) / ALIGN_WIDTH_DEG));
  return best;
}

/** A point on the dial at an angle (degrees from straight up) and radius. */
export function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [DIAL.cx + r * Math.sin(a), DIAL.cy - r * Math.cos(a)];
}

/** The angle of a pointer at (x, y) in the dial's SVG units, clamped to the scale. */
export function angleAt(x: number, y: number): number {
  return clampAngle((Math.atan2(x - DIAL.cx, -(y - DIAL.cy)) * 180) / Math.PI);
}

/** Tick spacing in degrees by the window's width in px: 2.5 on a phone, 2 on a tablet, 1 past 900 px of glass. */
export function tickStep(widthPx: number): number {
  return widthPx > 900 ? 1 : widthPx > 520 ? 2 : 2.5;
}

/** The eye's shadow wedge in degrees: wide off station, a hairline on one. */
export function eyeWedge(align: number): number {
  return 8 + (1 - align) * 110;
}

/** The magic eye's lit fan as an SVG path (viewBox 0 0 64 64), leaving a wedge of `deg` open at the top. */
export function eyePath(deg: number): string {
  const r = 28;
  const c = 32;
  const w = Math.max(4, deg);
  const a0 = ((-90 + w / 2) * Math.PI) / 180;
  const a1 = ((270 - w / 2) * Math.PI) / 180;
  const f = (n: number) => n.toFixed(2);
  return `M${c} ${c} L${f(c + r * Math.cos(a0))} ${f(c + r * Math.sin(a0))} A${r} ${r} 0 1 1 ${f(c + r * Math.cos(a1))} ${f(c + r * Math.sin(a1))} Z`;
}
