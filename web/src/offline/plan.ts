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
 * every voice another saved work records or uses in today's cast. `saved`
 * maps each saved work (the removed one included) to its voices as
 * recorded, or null where no record exists; `todayCasts` maps saved works
 * to the voices today's casting rule gives them (a recast after saving can
 * make a work need a voice its record lacks). With any other saved work's
 * record unknown, or its cast today unknown (its text is not on the page),
 * no voice is deleted: one might be needed, and a voice left behind costs
 * only space.
 */
export function voicesToRemove(
  removing: string,
  saved: ReadonlyMap<string, readonly string[] | null>,
  todayCasts: ReadonlyMap<string, readonly string[]>,
): string[] {
  const mine = saved.get(removing);
  if (!mine) return [];
  const kept = new Set<string>();
  for (const [slug, voices] of saved) {
    if (slug === removing) continue;
    const today = todayCasts.get(slug);
    if (voices === null || !today) return [];
    for (const v of voices) kept.add(v);
    for (const v of today) kept.add(v);
  }
  return workVoices(mine).filter((v) => !kept.has(v));
}

/** A record widened to cover today's cast: the old voices, then any new ones, each once. */
export function unionVoices(old: readonly string[] | null, today: readonly string[]): string[] {
  return workVoices([...(old ?? []), ...today]);
}

/** The voice record of a saved work that plays Dial's prepared recording: it needs no voice. */
export const NO_VOICES = "none";

/** A recorded voice list ("am_fenrir,am_puck"; "none" for a prepared recording), or null when there is no usable record. */
export function parseVoices(header: string | null): string[] | null {
  if (header === NO_VOICES) return [];
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

// ---- A work with a prepared recording ---------------------------------------
// It saves the recording Dial made in advance (its parts and timing index),
// its text (the read-along and the check that the recording is of these
// words) and the voice manifest (small; offline it gives the page the voice
// pins its offline key is made of; the recordings' pins are compiled into
// the page). No voice: the 115 MB model is not downloaded for it. A file
// counts as kept only when its kept bytes hash to its pin in this build.

/** One file a saved recording keeps, by the path it is served at, with the SHA-256 its kept bytes must have. */
export interface PinnedFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface KeptFile extends PinnedFile {
  /** Kept on this device, and its kept bytes hash to `sha256`. */
  kept: boolean;
}

export interface RecordingPlan {
  kind: "recording";
  textBytes: number;
  textSaved: boolean;
  files: KeptFile[];
}

/**
 * The files a saved recording keeps, with their true sizes and pins: its
 * parts in the encoding this browser uses (T5b: Opus by default, m4a where
 * that is what plays here), the index (its compiled pin, shared by both
 * encodings) and the voice manifest (as fetched now: a saved copy of an
 * older one is not kept).
 */
export function recordingFiles(
  slug: string,
  parts: readonly { file: string; bytes: number; sha256: string; m4a: { file: string; bytes: number; sha256: string } }[],
  index: { bytes: number; sha256: string },
  voiceManifest: { bytes: number; sha256: string },
  format: "opus" | "m4a" = "opus",
): PinnedFile[] {
  return [
    ...parts.map((p) => {
      const pin = format === "m4a" ? p.m4a : p;
      return { path: `/recordings/${slug}/${pin.file}`, bytes: pin.bytes, sha256: pin.sha256 };
    }),
    { path: `/recordings/${slug}/index.json`, bytes: index.bytes, sha256: index.sha256 },
    { path: "/voice/manifest.json", bytes: voiceManifest.bytes, sha256: voiceManifest.sha256 },
  ];
}

/** The saved cache's keys (paths) for one work's prepared recording: its parts (either encoding) and index, never the shared lists. */
export function recordingKeysOf(paths: readonly string[], slug: string): string[] {
  return paths.filter((p) => p.startsWith(`/recordings/${slug}/`) && /^\/recordings\/[a-z0-9-]+\/(index\.json|part\d+\.(webm|m4a))$/.test(p));
}

export type AnyPlan = SavePlan | RecordingPlan;

const isRecording = (p: AnyPlan): p is RecordingPlan => "kind" in p && p.kind === "recording";

/** Everything saving would download: the text (unless kept), and the voice bytes or the recording's files not yet kept. */
export function planTotal(p: AnyPlan): number {
  const text = p.textSaved ? 0 : p.textBytes;
  if (isRecording(p)) return text + p.files.filter((f) => !f.kept).reduce((n, f) => n + f.bytes, 0);
  return text + p.voiceBytes;
}

/** Saved means every piece is on this device: the text, the voice files or the recording the work needs, and the app's own files. */
export function isSaved(p: AnyPlan, shellKept: boolean): boolean {
  if (isRecording(p)) return p.textSaved && p.files.every((f) => f.kept) && shellKept;
  return p.textSaved && p.voiceBytes === 0 && shellKept;
}

/** The bytes a saved recording occupies: its text and every file it keeps. */
export function recordingOnDevice(p: RecordingPlan): number {
  return p.files.reduce((n, f) => n + f.bytes, p.textBytes);
}

/** Megabytes to one place, or kilobytes below a tenth of a megabyte. */
const size = (bytes: number) => (bytes < 100_000 ? kilobytes(bytes) : `${mb1(bytes)} MB`);

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
export function sizeLine(p: AnyPlan): string {
  if (isRecording(p)) {
    const total = planTotal(p);
    const recording = p.files.some((f) => !f.kept && (f.path.endsWith(".webm") || f.path.endsWith(".m4a")));
    return recording ? `${size(total)}: the recording Dial made in advance, and its text. No voice download.` : `${size(total)}: the rest of what the recording needs offline. No voice download.`;
  }
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

/** Under "Saved for offline" for a work saved with its prepared recording. */
export function recordingSavedLine(onDeviceBytes: number, persisted: boolean): string {
  const base = `Plays in Dial with no connection. ${mb1(onDeviceBytes)} MB on this device: the recording Dial made in advance, with no voice download.`;
  return persisted ? base : `${base} This browser may clear it if the device runs short of space.`;
}

/** The bytes a saved work occupies: its text, the whole voice model and runtime, its voices, and the offline extras. */
export function onDeviceBytes(m: SizedManifest, voices: readonly string[], textBytes: number, extras: readonly { path: string; bytes: number }[]): number {
  const nothingHeld: Held = { model: false, modelFiles: new Set(), runtime: false, voices: new Set() };
  // neededBytes with nothing held counts all of /ort/, the runtime's script included.
  return textBytes + neededBytes(m, voices, nothingHeld).bytes + extras.filter((e) => !e.path.startsWith("/ort/")).reduce((a, e) => a + e.bytes, 0);
}

export const SAVE_OFFLINE_NOT_SAVED = "Needs a connection to save or play.";
export const SAVED_OLDER = "Saved for the new version of Dial";
export const SAVED_OLDER_LINE = "Close every Dial tab, then reopen it with a connection.";

/**
 * The saved state: "saved" when every piece is here and the serving helper's
 * offline-compatibility key is the key of the saved data (the voice
 * manifest the page read: online the site's, offline the saved copy);
 * "older" when every piece is here but the helper is an older Dial's, which
 * would play a different voice or cast offline; otherwise not saved.
 */
export function savedState(p: AnyPlan, shell: { ok: boolean; key: string | null }, dataKey: string | null): "saved" | "older" | "no" {
  if (!isSaved(p, shell.ok)) return "no";
  return dataKey !== null && shell.key === dataKey ? "saved" : "older";
}

/** Said once a save ends, matching what the row then shows. */
export function saveEndLine(state: "saved" | "older" | "no", called: string): string {
  if (state === "saved") return `Saved ${called} for offline.`;
  if (state === "older") return `Saved ${called} for the new version of Dial. Close every Dial tab, then reopen it with a connection.`;
  return `${called.charAt(0).toUpperCase()}${called.slice(1)} was not saved on this device.`;
}
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
