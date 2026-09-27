// Provenance: tweaked from sadhana frontend/app/lib/usePerfTier.ts (sadhana
// a121809, read-only; nothing copied into it). Lifted: the low-tier signals
// (device memory of 2 GB or less, 4 cores or fewer, Save-Data, a 2g
// connection, Android 10 or older). Changed: the React hook becomes a pure
// function of a navigator-like object. Left behind (design/spec.md 0.6):
// any use as a speed estimate. The tier only thins the drawing (fewer wave
// points, no ghost lines); Dial measures speech speed on the device and
// never guesses it from memory, cores or the user agent.

export type PerfTier = "low" | "standard";

export interface NavigatorLike {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  userAgent?: string;
  connection?: { saveData?: boolean; effectiveType?: string };
}

export function detectPerfTier(nav: NavigatorLike | undefined): PerfTier {
  if (!nav) return "standard";
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 2) return "low";
  if (typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 4) return "low";
  if (nav.connection?.saveData === true) return "low";
  if (nav.connection?.effectiveType === "2g" || nav.connection?.effectiveType === "slow-2g") return "low";
  const m = /Android (\d+)/.exec(nav.userAgent ?? "");
  if (m && Number(m[1]) <= 10) return "low";
  return "standard";
}

/** How the wave is drawn on each tier: the x step in dial units, and whether the two ghost lines are drawn. */
export function waveDetail(tier: PerfTier): { step: number; ghosts: boolean } {
  return tier === "low" ? { step: 6, ghosts: false } : { step: 3, ghosts: true };
}
