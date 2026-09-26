// The first voice download, stated from the manifest's totalBytes
// (scripts/fetch-voice.mjs sums the staged files), never from a guess.

/** A total the page may state and measure against: a finite, positive byte count. */
export function isStatableTotal(total: unknown): total is number {
  return typeof total === "number" && Number.isFinite(total) && total > 0;
}

/** Decimal megabytes, rounded: 114,527,513 bytes is "about 115 MB". */
export function aboutMegabytes(totalBytes: number): string {
  return `about ${Math.round(totalBytes / 1_000_000)} MB`;
}

/**
 * The status line while the voice warms. On a repeat visit the voice is
 * already kept on this device, so no download is claimed; without a usable
 * total, no size is stated.
 */
export function warmingLine(totalBytes: unknown, fromDevice: boolean): string {
  if (fromDevice) return "Warming the voice from this device.";
  if (!isStatableTotal(totalBytes)) return "Warming the voice.";
  return `Warming the voice. It downloads once (${aboutMegabytes(totalBytes)}) and is kept on this device.`;
}
