// The voice download, stated from the bytes this visit still needs
// (web/src/voice-cache.ts neededBytes, from the manifest's per-file sizes),
// never from a guess.

import type { Need } from "./voice-cache";

/** A total the page may state and measure against: a finite, positive byte count. */
export function isStatableTotal(total: unknown): total is number {
  return typeof total === "number" && Number.isFinite(total) && total > 0;
}

/** Decimal megabytes, rounded, never below 1: 114,527,513 bytes is "about 115 MB", 1,044,480 is "about 1 MB". */
export function aboutMegabytes(totalBytes: number): string {
  return `about ${Math.max(1, Math.round(totalBytes / 1_000_000))} MB`;
}

/**
 * The status line while the voice warms. When everything is already kept on
 * this device, no download is claimed; when only this work's voices are
 * missing, only they are named; without a usable total, no size is stated.
 */
export function warmingLine(totalBytes: unknown, need: Need, called: string, missingVoices = 1): string {
  if (need === "none") return "Warming the voice from this device.";
  if (!isStatableTotal(totalBytes)) return "Warming the voice.";
  if (need === "voices") return `Adding the ${missingVoices === 1 ? "voice" : "voices"} for ${called} (${aboutMegabytes(totalBytes)}) to this device.`;
  return `Warming the voice. It downloads once (${aboutMegabytes(totalBytes)}) and is kept on this device.`;
}
