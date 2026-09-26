// Plain words for the broadcast status. Engine and browser error text
// ("Failed to fetch", a stack message) is never shown; each known failure
// maps to what happened and the real fix, and anything else gets one
// generic line. Listener copy never says "render" (design/spec.md 1.8).

export const STOP_OFFLINE = "Could not reach Dial. Check your connection, then press Tune in again.";
/** Dial answered, with an error status: the connection is fine, so it does not say to check it. */
export const STOP_SERVER = "Dial could not send the voice. Try again later.";
export const STOP_STORAGE = "This device is out of storage for the voice. Free some space, then press Tune in again.";
export const STOP_UNKNOWN = "The voice stopped unexpectedly. Press Tune in to try again.";

/** The status line for a broadcast that stopped, from the worker's "<name>: <message>". */
export function stopLine(raw: string): string {
  if (/QuotaExceeded|quota|no room|out of (storage|space)/i.test(raw)) return STOP_STORAGE;
  // Dial's own files answered with an HTTP status ("voice part model_quantized.part2: 503").
  if (/: \d{3}$/.test(raw)) return STOP_SERVER;
  // A fetch that never reached this origin.
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(raw)) return STOP_OFFLINE;
  return STOP_UNKNOWN;
}

/** Said with the progress when some part of the voice could not be stored. */
export const NOT_KEPT = "The voice could not be kept on this device, so it will download again next time.";

const withKept = (line: string, kept: boolean) => (kept ? line : `${line} ${NOT_KEPT}`);

/** While lines are being made and played on this device. */
export function renderingLine(done: number, total: number, kept: boolean): string {
  const line = done === 0 ? "Making the first line on this device." : `On air. Made on this device as you listen: line ${done} of ${total}.`;
  return withKept(line, kept);
}

/** "20:12", "1:05:09": a running time for the status line. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

/** Every line is made. `seconds` is the finished recording's length. */
export function renderedLine(total: number, seconds: number, kept: boolean): string {
  return withKept(`Made on this device. All ${total} lines, ${clock(seconds)}. Nothing was sent anywhere.`, kept);
}

/** Paused at a line; while the rest is still being made, it says so (the lamp stays lit for that). */
export function pausedLine(atSeconds: number, line: number, total: number, stillMaking: boolean): string {
  const base = `Paused at ${clock(atSeconds)}. Line ${line} of ${total}.`;
  return stillMaking ? `${base} The rest is still being made on this device.` : base;
}

/** Before Tune in: where the audio will come from. No work has a recording Dial made in advance yet. */
export const MADE_HERE = "Made on your device as you listen. The voice downloads the first time, then is kept on this device.";

/** The works' texts could not be fetched. */
export const STATIONS_UNREACHED = "The stations did not load. The works could not be fetched from dial.voidvision.org. Check your connection, then try again.";
export const STATIONS_SERVER = "The stations did not load. Dial could not send the works. Try again later.";
