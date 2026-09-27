// "Save for offline" as pure functions: which voices a saved work holds on
// to, what Remove may delete, and the save row's words, each stated from
// bytes the code has measured (voice-cache.ts neededBytes, the manifest's
// per-file sizes, the text's own length), never a guess.
//
// "Save for offline" keeps a work playable inside Dial with no connection,
// in Dial's own storage on this device. It is not "Download as an audio
// file", which writes a WAV to the listener's files (design/spec.md 1.9).

import { aboutMegabytes } from "../download-size";
import { neededBytes, type Held, type Need, type SizedManifest } from "../voice-cache";

/** The voices a work's cast uses, each once, in first-use order. */
export function workVoices(voices: readonly string[]): string[] {
  return [...new Set(voices)];
}

/**
 * The voices Remove may delete: the removed work's recorded voices, less
 * every voice another saved work records. `saved` maps each saved work (the
 * removed one included) to its voices as recorded at save time, or null
 * where no record exists. With any record unknown, no voice is deleted:
 * one might be needed, and a voice left behind costs only space.
 */
export function voicesToRemove(removing: string, saved: ReadonlyMap<string, readonly string[] | null>): string[] {
  const mine = saved.get(removing);
  if (!mine) return [];
  const kept = new Set<string>();
  for (const [slug, voices] of saved) {
    if (slug === removing) continue;
    if (voices === null) return [];
    for (const v of voices) kept.add(v);
  }
  return workVoices(mine).filter((v) => !kept.has(v));
}

/** A recorded voice list ("bm_george,bm_fable"), or null when there is no usable record. */
export function parseVoices(header: string | null): string[] | null {
  if (!header) return null;
  const ids = header.split(",").map((v) => v.trim());
  return ids.every((v) => /^[a-z]{2}_[a-z]+$/.test(v)) ? ids : null;
}

/** Files an offline Tune in fetches that only the saved cache keeps: the voice manifest and the runtime's scripts. */
export function offlineExtras(m: Pick<SizedManifest, "sizes">): string[] {
  return ["/voice/manifest.json", ...Object.keys(m.sizes).filter((p) => /^\/ort\/[^/]+\.mjs$/.test(p))];
}

export interface SavePlan {
  /** The work's text, in bytes (UTF-8). */
  textBytes: number;
  /** The voice's bytes still to download: the model, runtime and this work's voices not held, plus the offline extras not held. */
  voiceBytes: number;
  need: Need;
  /** Whether the text is already saved. */
  textSaved: boolean;
}

/**
 * What saving a work still costs. `extrasMissing` are offlineExtras() not yet
 * kept, with their sizes (the manifest's own size is its length as fetched).
 * While the runtime is not held, neededBytes already counts its script with
 * the rest of /ort/, so it is not counted twice.
 */
export function savePlan(
  m: SizedManifest,
  voices: readonly string[],
  held: Held,
  textBytes: number,
  textSaved: boolean,
  extrasMissing: readonly { path: string; bytes: number }[],
): SavePlan {
  const n = neededBytes(m, voices, held);
  const extras = extrasMissing.filter((e) => held.runtime || !e.path.startsWith("/ort/")).reduce((a, e) => a + e.bytes, 0);
  return { textBytes, voiceBytes: n.bytes + extras, need: n.need, textSaved };
}

/** Everything saving would download: the plan's text (unless kept) and voice bytes. */
export function planTotal(p: SavePlan): number {
  return (p.textSaved ? 0 : p.textBytes) + p.voiceBytes;
}

/** Saved means every piece is on this device: the text, the voice files the work needs, and the app's own files. */
export function isSaved(p: SavePlan, shellKept: boolean): boolean {
  return p.textSaved && p.voiceBytes === 0 && shellKept;
}

/** "29 kB": whole kilobytes (decimal), never below 1. */
export function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1000))} kB`;
}

/** "48.2": decimal megabytes to one place. */
export function mb1(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/**
 * The line beside "Save for offline": what it will store.
 * - Nothing of the voice held: "29 kB of text, plus the voice, once (about 115 MB)."
 * - Only this work's voices missing: "... plus this work's voice (about 1 MB). The rest of the voice is already on this device."
 * - The whole voice held: "29 kB of text. The voice is already on this device."
 */
export function sizeLine(p: SavePlan): string {
  const text = `${kilobytes(p.textBytes)} of text`;
  if (p.voiceBytes === 0) return `${text}. The voice is already on this device.`;
  if (p.need === "all") return `${text}, plus the voice, once (${aboutMegabytes(p.voiceBytes)}).`;
  if (p.need === "voices") return `${text}, plus this work's voices (${aboutMegabytes(p.voiceBytes)}). The rest of the voice is already on this device.`;
  // Only the small files an offline Tune in needs are missing.
  return `${text}, plus ${kilobytes(p.voiceBytes)} the voice needs offline. The voice is already on this device.`;
}

/** "Saving… 48.2 of 114.6 MB" (the numbers are wrapped for the data face by the page). */
export function savingLine(loaded: number, total: number): string {
  return `Saving… ${mb1(Math.min(loaded, total))} of ${mb1(total)} MB`;
}

/**
 * Under "Saved for offline". `persisted` is the browser's answer to the
 * persistent-storage request: when it declined, or cannot say, the line
 * says the browser may clear the work under storage pressure.
 */
export function savedLine(onDeviceBytes: number, persisted: boolean): string {
  const base = `Plays in Dial with no connection. ${mb1(onDeviceBytes)} MB on this device, the voice shared by every saved work.`;
  return persisted ? base : `${base} This browser may clear it if the device runs short of space.`;
}

/** The bytes a saved work occupies: its text, the whole voice model and runtime, its voices, and the offline extras. */
export function onDeviceBytes(m: SizedManifest, voices: readonly string[], textBytes: number, extras: readonly { path: string; bytes: number }[]): number {
  const nothingHeld: Held = { model: false, modelFiles: new Set(), runtime: false, voices: new Set() };
  // neededBytes with nothing held counts all of /ort/, the runtime's script included.
  return textBytes + neededBytes(m, voices, nothingHeld).bytes + extras.filter((e) => !e.path.startsWith("/ort/")).reduce((a, e) => a + e.bytes, 0);
}

export const SAVE_OFFLINE_NOT_SAVED = "Needs a connection to save or play.";
export const WORK_NOT_ON_DEVICE = "This work isn't saved on this device. It needs a connection to play.";
export const OFFLINE_NOTICE = "Offline. Works saved on this device play as usual. The others need a connection.";

/** Why a save stopped, in plain words with the fix; engine and browser text is never shown. */
export function saveFailedLine(raw: string): string {
  if (/ShellError/.test(raw)) return "Dial could not keep its own page files on this device, so nothing was saved. Reload the page, then try again.";
  if (/QuotaExceeded|quota|no room|out of (storage|space)/i.test(raw)) return "There is no room on this device to save it. Free some space, then try again.";
  if (/: \d{3}$/.test(raw)) return "Dial could not send the files. Try again later.";
  if (/pin/i.test(raw)) return "A file arrived damaged, so nothing was saved from it. Try again.";
  return "Could not reach Dial. Check your connection, then try again.";
}
