// A prepared recording as a source of lines for the player: the same shape
// a render made in this tab has (each line's speech as 16-bit samples at
// 24 kHz, then its silence from the pause table), so the one scheduler,
// wave, meters, lamp, read-along and script sheet play either.
//
// Every file comes from this origin (Law 1: /recordings/ is in
// privacy-allowlist.json) and is checked before it is used: the index
// against the pin in /recordings/manifest.json, each part against the
// index. The index is used only when every line's hash is the one this page
// computes from the text and its cast (timing.ts indexProblem), so the words
// heard are the words shown. Parts are fetched as playback reaches them and
// decoded to 24 kHz; only a few decoded parts are held at a time.

import { sha256Hex } from "../voice-files";
import { CAST_ENGINE_VERSION } from "../engine/cast-version";
import { RECORDING_RATE, expectedDigest, indexProblem, lineSlice, partOfLine, type RecordingIndex } from "./timing";

/** /recordings/manifest.json (scripts/fetch-recordings.mjs): what this build serves. */
export interface RecordingEntry {
  /** The index's SHA-256. */
  index: string;
  /** Every byte of the recording: its parts and its index. */
  bytes: number;
  parts: number;
  seconds: number;
  /** The day it was made, YYYY-MM-DD. */
  made: string;
  cast: string;
  model: string;
  device: string;
}

export interface RecordingsManifest {
  format: number;
  tag: string;
  works: Record<string, RecordingEntry>;
}

/** Each work's index pin, for the offline key. */
export function recordingPins(m: RecordingsManifest | null): Record<string, string> {
  return m ? Object.fromEntries(Object.entries(m.works).map(([slug, w]) => [slug, w.index])) : {};
}

/** What this build serves; null when it cannot be read (offline with nothing saved), and then every work is made on the device. */
export async function readRecordings(): Promise<{ manifest: RecordingsManifest; text: string; bytes: number } | null> {
  try {
    const res = await fetch("/recordings/manifest.json");
    if (!res.ok) return null;
    const text = await res.text();
    const manifest = JSON.parse(text) as RecordingsManifest;
    if (manifest.format !== 1 || typeof manifest.works !== "object" || !manifest.works) return null;
    return { manifest, text, bytes: new TextEncoder().encode(text).byteLength };
  } catch {
    return null;
  }
}

export const MAX_DECODED_PARTS = 3;

/** Whether this browser can play Opus in WebM, the recordings' format. Where it cannot, every work is made on the device. */
export function canPlayRecordings(): boolean {
  try {
    return typeof OfflineAudioContext !== "undefined" && new Audio().canPlayType('audio/webm; codecs="opus"') !== "";
  } catch {
    return false;
  }
}

/** Decodes a part to mono samples at 24 kHz. Replaced in tests. */
export type Decoder = (bytes: ArrayBuffer) => Promise<Float32Array>;

export const decodeAt24k: Decoder = async (bytes) => {
  // An offline context at 24 kHz decodes (and resamples) to the rate the lines are measured in.
  const ctx = new OfflineAudioContext(1, 1, RECORDING_RATE);
  const buf = await ctx.decodeAudioData(bytes);
  return buf.getChannelData(0);
};

function toInt16(samples: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export class Recording {
  private readonly decoded = new Map<number, Promise<Float32Array>>();

  constructor(
    readonly slug: string,
    readonly index: RecordingIndex,
    /** The index file as served: its size and SHA-256 (what Save for offline keeps and checks). */
    readonly indexFile: { bytes: number; sha256: string },
    private readonly decode: Decoder = decodeAt24k,
    private readonly fetchPart: (file: string) => Promise<ArrayBuffer> = (file) => fetchRecordingPart(slug, file),
  ) {}

  get lineCount(): number {
    return this.index.lines.length;
  }

  /** Line i's speech and silence, in seconds. */
  line(i: number): { speech: number; pause: number } {
    const l = this.index.lines[i]!;
    return { speech: l.speech / this.index.sampleRate, pause: l.pause / this.index.sampleRate };
  }

  /** The whole recording, in seconds. */
  get seconds(): number {
    return this.index.samples / this.index.sampleRate;
  }

  /** Fetches, checks and decodes part p, once; the oldest decoded parts beyond MAX_DECODED_PARTS are let go. */
  private part(p: number): Promise<Float32Array> {
    let hit = this.decoded.get(p);
    if (hit) {
      // Most recently used last.
      this.decoded.delete(p);
      this.decoded.set(p, hit);
      return hit;
    }
    const pin = this.index.parts[p]!;
    hit = this.fetchPart(pin.file).then(async (bytes) => {
      if (bytes.byteLength !== pin.bytes || (await sha256Hex(bytes)) !== pin.sha256) throw new Error("recording: a part did not match its pin");
      return this.decode(bytes);
    });
    // A failed part is not held, so asking again fetches it again.
    hit.catch(() => this.decoded.delete(p));
    this.decoded.set(p, hit);
    while (this.decoded.size > MAX_DECODED_PARTS) this.decoded.delete(this.decoded.keys().next().value!);
    return hit;
  }

  /** Line i's speech as 16-bit samples at 24 kHz, exactly the shape a line made in this tab has. */
  async samples(i: number): Promise<Int16Array<ArrayBuffer>> {
    const p = partOfLine(this.index, i);
    if (p < 0) throw new Error(`recording: no part holds line ${i + 1}`);
    const audio = await this.part(p);
    const { from, frames } = lineSlice(this.index, i, RECORDING_RATE, audio.length);
    // The next part starts downloading while this one plays.
    if (i === this.index.parts[p]!.from && p + 1 < this.index.parts.length) void this.part(p + 1).catch(() => undefined);
    return toInt16(audio.subarray(from, from + frames));
  }

  /** How many parts are decoded and held (for tests). */
  get held(): number {
    return this.decoded.size;
  }
}

async function fetchRecordingPart(slug: string, file: string): Promise<ArrayBuffer> {
  const res = await fetch(`/recordings/${slug}/${file}`);
  if (!res.ok) throw new Error(`recording part ${file}: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Opens a work's prepared recording, or says why it cannot stand in for a
 * render made here: the index must match its pin, and its lines the text's
 * cues and cast exactly. `null` problem means the recording is usable.
 */
export async function openRecording(
  slug: string,
  entry: RecordingEntry,
  cues: readonly { start: number; end: number; spoken: string; pauseAfterMs: number }[],
  voices: readonly string[],
): Promise<{ recording: Recording; problem: null } | { recording: null; problem: string }> {
  const res = await fetch(`/recordings/${slug}/index.json`);
  if (!res.ok) throw new Error(`recording index: ${res.status}`);
  const buf = await res.arrayBuffer();
  if ((await sha256Hex(buf)) !== entry.index) return { recording: null, problem: "the index did not match its pin" };
  const index = JSON.parse(new TextDecoder().decode(buf)) as RecordingIndex;
  const problem = indexProblem(index, { digest: await expectedDigest(cues, voices), lines: cues.length, castVersion: CAST_ENGINE_VERSION });
  if (problem) return { recording: null, problem };
  return { recording: new Recording(slug, index, { bytes: buf.byteLength, sha256: entry.index }), problem: null };
}
