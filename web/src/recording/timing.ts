// A prepared recording's timing index, as pure functions shared by the
// render (scripts/render-recordings.mjs, in Node) and the page. The index
// says where every line starts in the recording, how long its speech and
// its silence are, and a hash of what was spoken in which voice, so the
// page plays a recording only when it was made from exactly the cues and
// cast the page itself computes (Law 2 and Law 3 hold for it as they hold
// for a render made in the tab).
//
// Work time runs from 0 at the first word; a line's length is its speech
// plus the silence after it from the pause table, exactly as the tab's WAV
// lays it out (engine/wav.ts). The recording is cut into parts only at the
// start of a line, so every line's speech lies inside one part.

/** Bumped when the index's shape or the hash's inputs change. */
export const RECORDING_FORMAT = 1;

/** The rate Kokoro speaks at; line lengths are whole samples at this rate. */
export const RECORDING_RATE = 24000;

export interface RecordingPart {
  /** File name under /recordings/<slug>/. */
  file: string;
  /** Where the part starts in work time (the start of its first line). */
  start: number;
  /** Its length in work time, to the start of the next part. */
  seconds: number;
  /** The first line in the part, and one past its last. */
  from: number;
  to: number;
  bytes: number;
  sha256: string;
}

export interface RecordingLine {
  /** Start in work time, in samples at RECORDING_RATE. */
  at: number;
  /** Speech samples at RECORDING_RATE, then the silence after it, in samples. */
  speech: number;
  pause: number;
  /** cueHash() of the line as spoken. */
  hash: string;
}

export interface RecordingEngine {
  /** CAST_ENGINE_VERSION the cast was computed with. */
  cast: string;
  model: string;
  modelSha256: string;
  dtype: string;
  kokoroJs: string;
  runtime: string;
  /** Where the speech was made: "cpu", or the GPU provider that made it. */
  device: string;
}

export interface RecordingIndex {
  format: number;
  slug: string;
  /** The day it was made, YYYY-MM-DD. */
  made: string;
  engine: RecordingEngine;
  sampleRate: number;
  /** Total length in samples at sampleRate. */
  samples: number;
  /** cuesDigest() of every line's hash, in order. */
  digest: string;
  codec: string;
  bitrate: number;
  parts: RecordingPart[];
  lines: RecordingLine[];
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Text(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The hash of one line as spoken: where it sits in the text, the voice, the words given to the voice, and the silence after. */
export function cueHash(cue: { start: number; end: number; spoken: string; pauseAfterMs: number }, voice: string): Promise<string> {
  return sha256Text(JSON.stringify([cue.start, cue.end, voice, cue.spoken, cue.pauseAfterMs]));
}

/** One digest over every line's hash, in order. */
export function cuesDigest(hashes: readonly string[]): Promise<string> {
  return sha256Text(hashes.join("\n"));
}

/** The digest the page expects for a work: its cues, cast voice by voice. */
export async function expectedDigest(cues: readonly { start: number; end: number; spoken: string; pauseAfterMs: number }[], voices: readonly string[]): Promise<string> {
  if (voices.length !== cues.length) throw new Error("recording: one voice per line");
  return cuesDigest(await Promise.all(cues.map((c, i) => cueHash(c, voices[i]!))));
}

/**
 * Whether an index can stand in for a render made here: same format, same
 * cast engine, and every line's hash the same (so the same words, voices
 * and silences), with parts that tile the lines. Returns the reason it
 * cannot, or null when it can.
 */
export function indexProblem(index: RecordingIndex, expected: { digest: string; lines: number; castVersion: string }): string | null {
  if (index.format !== RECORDING_FORMAT) return `format ${index.format}`;
  if (index.engine.cast !== expected.castVersion) return `cast engine ${index.engine.cast}, this page ${expected.castVersion}`;
  if (index.lines.length !== expected.lines) return `${index.lines.length} lines, the text has ${expected.lines}`;
  if (index.digest !== expected.digest) return "the lines differ from this text's";
  let at = 0;
  for (const l of index.lines) {
    if (l.at !== at || l.speech < 0 || l.pause < 0) return "the lines do not follow one another";
    at += l.speech + l.pause;
  }
  if (at !== index.samples) return "the lines do not add up to the recording";
  let from = 0;
  for (const p of index.parts) {
    if (p.from !== from || p.to <= p.from) return "the parts do not tile the lines";
    from = p.to;
  }
  if (from !== index.lines.length) return "the parts do not cover every line";
  return null;
}

/** Line lengths in seconds (speech, pause), as the player's clock uses them. */
export function lineSeconds(index: Pick<RecordingIndex, "lines" | "sampleRate">): { speech: number; pause: number }[] {
  return index.lines.map((l) => ({ speech: l.speech / index.sampleRate, pause: l.pause / index.sampleRate }));
}

/** The line playing at work time t (seconds): the last one starting at or before it; 0 before the first, the last after the end. */
export function lineAtTime(index: Pick<RecordingIndex, "lines" | "sampleRate">, t: number): number {
  const s = t * index.sampleRate;
  let lo = 0;
  let hi = index.lines.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.lines[mid]!.at <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The part holding line i. */
export function partOfLine(index: Pick<RecordingIndex, "parts">, i: number): number {
  return index.parts.findIndex((p) => i >= p.from && i < p.to);
}

/**
 * Where line i's speech lies inside its part's decoded audio, in frames at
 * `rate` (the rate the audio was decoded to): its first frame and how many.
 * Clamped to the decoded length, which an encoder may pad or trim by a frame.
 */
export function lineSlice(index: Pick<RecordingIndex, "lines" | "parts" | "sampleRate">, i: number, rate: number, decodedFrames: number): { from: number; frames: number } {
  const part = index.parts[partOfLine(index, i)]!;
  const line = index.lines[i]!;
  const partAt = index.lines[part.from]!.at;
  const from = Math.min(decodedFrames, Math.round(((line.at - partAt) / index.sampleRate) * rate));
  const frames = Math.max(0, Math.min(decodedFrames - from, Math.round((line.speech / index.sampleRate) * rate)));
  return { from, frames };
}

/** A seek to t seconds: the line it lands in and how far into that line; past the end, null. */
export function seekTo(index: Pick<RecordingIndex, "lines" | "sampleRate" | "samples">, t: number): { index: number; offset: number } | null {
  const target = Math.max(0, t);
  if (target * index.sampleRate >= index.samples) return null;
  const i = lineAtTime(index, target);
  return { index: i, offset: target - index.lines[i]!.at / index.sampleRate };
}

/** Where parts should begin: the first line at or after each `every` seconds of work time. Always starts with line 0. */
export function partBreaks(lines: readonly { speech: number; pause: number }[], rate: number, every: number): number[] {
  const breaks = [0];
  let at = 0;
  let partStart = 0;
  lines.forEach((l, i) => {
    if (i > 0 && at - partStart >= every * rate) {
      breaks.push(i);
      partStart = at;
    }
    at += l.speech + l.pause;
  });
  return breaks;
}

/** Every byte a saved recording keeps: its parts and the index file itself. */
export function recordingBytes(index: Pick<RecordingIndex, "parts">, indexBytes: number): number {
  return index.parts.reduce((n, p) => n + p.bytes, indexBytes);
}
