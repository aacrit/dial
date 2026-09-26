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

/** "20:12", "1:05:09": a running time for the status line. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}

// ---- The announced status: one line per change of state ------------------
// #broadcast-status is a polite live region, so it changes only when the
// broadcast's state does (warming, the first line, paused, done, stopped).
// The per-line count goes in the visual progress line below it.

/** The voice is loaded; the first line is being made. */
export function firstLineLine(title: string, kept: boolean): string {
  return withKept(`Making the first line of ${title} on this device.`, kept);
}

/** The first line is playing. */
export function onAirLine(title: string, kept: boolean): string {
  return withKept(`On air: ${title}. Made on this device as you listen.`, kept);
}

/** Paused; while the rest is still being made, it says so (the lamp stays lit for that). */
export function pausedLine(title: string, atSeconds: number, stillMaking: boolean): string {
  const base = `Paused: ${title} at ${clock(atSeconds)}.`;
  return stillMaking ? `${base} The rest is still being made on this device.` : base;
}

/**
 * Every line is made. True in every state it can show in: a count of the
 * finished work is sent (chapter_rendered), but the words and the audio
 * never leave the device.
 */
export function renderedLine(title: string, total: number, seconds: number, kept: boolean): string {
  return withKept(`Made on this device: all ${total} lines of ${title}, ${clock(seconds)}. The words and the audio never left this device.`, kept);
}

// ---- The visual progress line (not announced) ----------------------------

export interface Progress {
  title: string;
  /** The line playing (1-based; 0 before the first). */
  heard: number;
  /** Lines made so far. */
  made: number;
  total: number;
  paused: boolean;
  renderDone: boolean;
}

/** "On air: Crito, line 21 of 252. Made up to line 40." */
export function progressLine(p: Progress): string {
  const where = `${p.paused ? "Paused" : "On air"}: ${p.title}, line ${Math.max(1, p.heard)} of ${p.total}.`;
  return p.renderDone ? `${where} All lines made.` : `${where} Made up to line ${p.made}.`;
}

// ---- Before Tune in, and the works themselves ------------------------------

/**
 * Where the audio will come from. No work has a recording Dial made in
 * advance yet. The keeping clause is dropped once the voice could not be kept.
 */
export function madeHere(voiceKept: boolean): string {
  return voiceKept
    ? "Made on your device as you listen. The voice downloads the first time, then is kept on this device."
    : "Made on your device as you listen. The voice downloads each time, because this device could not keep it.";
}

/** Asked in the page before a broadcast still being made is stopped for another. */
export function switchQuestion(onAir: string, next: string): string {
  const cap = onAir.charAt(0).toUpperCase() + onAir.slice(1);
  const possessive = cap.endsWith("s") ? `${cap}'` : `${cap}'s`;
  return `Stop ${onAir} and tune in to ${next}? ${possessive} recording so far will be lost.`;
}

export function loadingNote(host: string): string {
  return `Warming up. Reading the works from ${host}.`;
}

/** The works' texts could not be fetched. */
export function stationsUnreached(host: string): string {
  return `The stations did not load. The works could not be fetched from ${host}. Check your connection, then try again.`;
}
/** A station whose cast sheet the voices cannot honour: only that station is unavailable. */
export const CAST_FAILED = "Dial could not cast this work's voices.";

export const STATIONS_SERVER = "The stations did not load. Dial could not send the works. Try again later.";
