// Provenance: net-new for Dial (no sadhana file). sadhana animates with
// framer-motion springs; Dial has no animation dependency (design/spec.md
// 0.6, BrandLoader.tsx row: "leave behind framer-motion"), so this is a
// plain Hooke's-law integrator, the same one the approved mocks run
// (design/mocks/device-motion.html). The presets are numbers only; `drop`
// is sadhana's Ragamala `kan` (frontend/app/components/Logo.tsx
// SPRING_PRESETS.kan, 1000 / 30 / 1, at sadhana a121809), lifted as numbers.
//
// Pure: no DOM, no clock. The caller steps it with the frame's real dt.

/** stiffness, damping, mass */
export type SpringParams = readonly [number, number, number];

/** Dial's named presets (design/tokens.css --spring-*; tests/radio.test.ts keeps the two equal). */
export const PRESETS = {
  /** Tuning between stations: a weighted needle, about 30% overshoot. */
  swing: [220, 11, 1.1],
  /** A line or the needle snapping into place; button release. */
  drop: [1000, 30, 1],
  /** Warming: the valve, the eye's power. */
  warm: [150, 12, 1.2],
  /** The magic eye's wedge (the VU standard: 99% in about 300 ms). */
  vu: [400, 32, 1],
  /** The needle or a knob tracking a finger while dragged. */
  follow: [900, 60, 1],
} as const satisfies Record<string, SpringParams>;

/** Sub-step size: small enough that the stiffest preset stays stable at any frame rate. */
const SUBSTEP = 1 / 240;

export class Spring {
  x: number;
  v = 0;
  target: number;
  params: SpringParams;

  constructor(params: SpringParams, x = 0) {
    this.params = params;
    this.x = x;
    this.target = x;
  }

  use(params: SpringParams): this {
    this.params = params;
    return this;
  }

  to(target: number): this {
    this.target = target;
    return this;
  }

  /** Puts the spring at rest on its target: reduced motion, or a first paint. */
  snap(): this {
    this.x = this.target;
    this.v = 0;
    return this;
  }

  /** Advances dt seconds. With reduce set, it lands on the target at once (reduced motion is law). */
  step(dt: number, reduce = false): this {
    if (reduce) return this.snap();
    const [k, c, m] = this.params;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = (-k * (this.x - this.target) - c * this.v) / m;
      this.v += a * h;
      this.x += this.v * h;
    }
    return this;
  }

  get resting(): boolean {
    return Math.abs(this.x - this.target) < 1e-3 && Math.abs(this.v) < 1e-3;
  }
}

/** Reads "220 11 1.1" from a token; anything else falls back to the preset. */
export function parseSpring(value: string | null | undefined, fallback: SpringParams): SpringParams {
  const v = (value ?? "").trim().split(/\s+/).map(Number);
  return v.length === 3 && v.every((n) => Number.isFinite(n) && n > 0) ? [v[0]!, v[1]!, v[2]!] : fallback;
}
