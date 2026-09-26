// Plain words for the broadcast status. Engine and browser error text
// ("Failed to fetch", a stack message) is never shown; each known failure
// maps to what happened and the real fix, and anything else gets one
// generic line.

export const STOP_OFFLINE = "Could not reach Dial. Check your connection, then press Tune in again.";
export const STOP_STORAGE = "This device is out of storage for the voice. Free some space, then press Tune in again.";
export const STOP_UNKNOWN = "The voice stopped unexpectedly. Press Tune in to try again.";

/** The status line for a render that stopped, from the worker's "<name>: <message>". */
export function stopLine(raw: string): string {
  if (/QuotaExceeded|quota|no room|out of (storage|space)/i.test(raw)) return STOP_STORAGE;
  // A fetch that never reached this origin, or one it answered with an error status.
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(raw) || /: \d{3}$/.test(raw)) return STOP_OFFLINE;
  return STOP_UNKNOWN;
}

/** Said with the render's progress when some part of the voice could not be stored. */
export const NOT_KEPT = "The voice could not be kept on this device, so it will download again next time.";

export function renderingLine(done: number, total: number, kept: boolean): string {
  const line = `Rendering on this device: ${done} of ${total} lines.`;
  return kept ? line : `${line} ${NOT_KEPT}`;
}

export function renderedLine(total: number, kept: boolean): string {
  const line = `Rendered. All ${total} lines, made on this device. Nothing was sent anywhere.`;
  return kept ? line : `${line} ${NOT_KEPT}`;
}
