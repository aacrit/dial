// Provenance: lifted from sadhana frontend/app/lib/useReducedMotion.ts (at
// sadhana a121809): the same query and a live `change` listener, so a user
// who switches the setting mid-session is obeyed at once. The React hook
// becomes a plain object for Dial's vanilla code (design/spec.md 0.6:
// "DialDevice.reduce"); every spring snaps while it is set.

const QUERY = "(prefers-reduced-motion: reduce)";

export const motion = { reduce: false };

export function watchReducedMotion(): void {
  if (typeof matchMedia !== "function") return;
  const mq = matchMedia(QUERY);
  motion.reduce = mq.matches;
  mq.addEventListener("change", (e) => {
    motion.reduce = e.matches;
  });
}
