// The first voice download, stated from the manifest's totalBytes
// (scripts/fetch-voice.mjs sums the staged files), never from a guess.

/** Decimal megabytes, rounded: 114,527,513 bytes is "about 115 MB". */
export function aboutMegabytes(totalBytes: number): string {
  return `about ${Math.round(totalBytes / 1_000_000)} MB`;
}

/** The status line while the voice warms on a first visit. */
export function warmingLine(totalBytes: number): string {
  return `Warming the voice. It downloads once (${aboutMegabytes(totalBytes)}) and then stays on this device.`;
}
