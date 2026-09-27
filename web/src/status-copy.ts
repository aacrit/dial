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
export function renderedLine(title: string, total: number, seconds: number, kept: boolean, madeFrom = 0): string {
  // Made here from a later line (Dial's recording could not be decoded): only those lines were made on this device.
  if (madeFrom > 0) {
    const rest = total - madeFrom === 1 ? "the last line" : `the last ${total - madeFrom} lines`;
    return withKept(`Made on this device from line ${madeFrom + 1}: ${rest} of ${title}. The words and the audio never left this device.`, kept);
  }
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

/** "On air: Crito, line 21 of 252. Made up to line 40."; for Dial's prepared recording, only where the listener is. */
export function progressLine(p: Progress & { prepared?: boolean }): string {
  const where = `${p.paused ? "Paused" : "On air"}: ${p.title}, line ${Math.max(1, p.heard)} of ${p.total}.`;
  if (p.prepared) return where;
  return p.renderDone ? `${where} All lines made.` : `${where} Made up to line ${p.made}.`;
}

// ---- Dial's prepared recording ---------------------------------------------
// Played from files Dial made in advance and this site serves: nothing is
// made on the device, and the words and the audio are never sent. The one
// count, chapter_rendered, is sent once 80% of the work has been heard.

/** Under Tune in, for a work whose prepared recording this page can play. */
export const PLAYS_AT_ONCE = "Plays at once: Dial made this recording in advance.";

/** The small secondary link beside it: today's render, made on the device. Once the voice could not be kept, it says it downloads each time. */
export function makeItHere(voiceKept: boolean): string {
  return voiceKept ? "Or make it on this device (the voice downloads once)" : "Or make it on this device (the voice downloads each time)";
}

/** Said when a part of Dial's recording cannot be decoded here, as the listen carries on made on the device from the line on air. */
export const RECORDING_UNPLAYABLE = "This browser can't play Dial's recording, so it's being made on this device.";

/** The button offered when Dial's recording stopped (a part did not arrive, twice): carry on from the line on air. */
export function resumeAtLine(line: number): string {
  return `Resume at line ${line}`;
}

/** "Jowett's": the translator's surname, possessive. */
function translatorsWords(translator: string): string {
  const surname = translator.split(" ").at(-1) ?? translator;
  return surname.endsWith("s") ? `${surname}'` : `${surname}'s`;
}

/** A prepared recording that stopped, in plain words with the fix. */
export function recordingStopLine(raw: string): string {
  if (/: \d{3}$/.test(raw)) return "Dial could not send its recording. Try again later, or make it on this device.";
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(raw)) return STOP_OFFLINE;
  if (/pin/i.test(raw)) return "Dial's recording arrived damaged. Press Tune in to try again.";
  if (/EncodingError|decode|Decoding/i.test(raw)) return "This browser could not play Dial's recording. Make it on this device instead.";
  return "Dial's recording stopped unexpectedly. Press Tune in to try again.";
}

/** Between Tune in and the first line: the first part is on its way. */
export function preparedTuningLine(title: string): string {
  return `Tuning in to Dial's recording of ${title}.`;
}

/** The first line is playing. */
export function preparedOnAirLine(translator: string): string {
  return `Playing a recording Dial made in advance from ${translatorsWords(translator)} words. Nothing is made while you listen, and the words and the audio never leave this device.`;
}

/** A skip went past the end: the broadcast is over, but nothing was heard to the end. */
export function preparedSkippedLine(title: string): string {
  return `Skipped to the end of Dial's recording of ${title}.`;
}

/** The listen reached the end. */
export function preparedDoneLine(title: string, seconds: number): string {
  return `Played Dial's recording of ${title} to the end, ${clock(seconds)}.`;
}

// ---- Before Tune in, and the works themselves ------------------------------

/**
 * Where the audio will come from, for a work made on the device (a work
 * whose prepared recording plays says PLAYS_AT_ONCE instead). The keeping
 * clause is dropped once the voice could not be kept.
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

// ---- Scrubbing (the progress strip, J/K/L and [ ]) --------------------------

/** A seek past what is made: it stops at the last made line, and says so. */
export function notMadeYet(made: number, total: number): string {
  return `Not made yet. This device has made ${made} of ${total} lines so far, so it plays from line ${made}.`;
}

/** A line in the script that is not made yet was chosen. */
export function lineNotMadeYet(line: number, made: number): string {
  return `Line ${line} is not made yet. This device has made ${made} so far.`;
}

/** The progress strip's reading: "01:27 of about 20:12. Line 9 of 118. Made up to 04:10." */
export function stripText(position: number, total: number, exact: boolean, line: number, lines: number, made: number, renderDone: boolean): string {
  const of = `${clock(position)} of ${exact ? "" : "about "}${clock(total)}. Line ${Math.max(1, line)} of ${lines}.`;
  return renderDone ? of : `${of} Made up to ${clock(made)}.`;
}

/** The script sheet's note: whose words, and what a chosen line does. */
export function scriptNote(translator: string, playable: boolean): string {
  const whose = `${translator.split(" ").at(-1)}'s words, exactly as printed.`;
  return playable ? `${whose} Choose a line to play from it.` : `${whose} Tune in to play from a line.`;
}
