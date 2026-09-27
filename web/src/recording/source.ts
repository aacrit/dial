// A prepared recording as a source of lines for the player: the same shape
// a render made in this tab has (each line's speech as 16-bit samples at
// 24 kHz, then its silence from the pause table), so the one scheduler,
// wave, meters, lamp, read-along and script sheet play either.
//
// Which works have one, and each index's pin, are compiled into the page at
// build (BUILT_RECORDINGS, from the staged list scripts/fetch-recordings.mjs
// writes), exactly as the offline helper compiles them into its key: the page
// never learns them from a fetched list. Every file comes from this origin
// (Law 1: /recordings/ is in privacy-allowlist.json) and is checked before it
// is used: the index against its compiled pin, each part against the index.
// The index is used only when every line's hash is the one this page
// computes from the text and its cast (timing.ts indexProblem), so the words
// heard are the words shown. Parts are fetched as playback nears them and
// decoded to 24 kHz; only a few decoded parts are held at a time.

import { sha256Hex } from "../voice-files";
import { CAST_ENGINE_VERSION } from "../engine/cast-version";
import { M4A_PART_FILE, PART_FILE, RECORDING_RATE, expectedDigest, indexProblem, lineSlice, partOfLine, type FilePin, type RecordingIndex } from "./timing";

/** Which encoding of Dial's prepared recording this browser plays: Opus in WebM, or AAC-LC in .m4a (T5b, for Safari). */
export type RecordingFormat = "opus" | "m4a";

/** One work's entry in the staged list (scripts/fetch-recordings.mjs). */
export interface RecordingEntry {
  /** The index's SHA-256: covers every part's pin in both encodings, since the index embeds both (T5b). */
  index: string;
  /** Every byte of the Opus recording: its parts and its index. */
  bytes: number;
  parts: number;
  /** Every byte of the m4a recording: its parts (the index is shared, counted above). */
  m4a: { bytes: number; parts: number };
  seconds: number;
  /** The day it was made, YYYY-MM-DD, in the maker's local time. */
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

declare const __RECORDINGS__: RecordingsManifest | undefined;

/** This build's prepared recordings, compiled in (web/vite.config.ts). None where the page was built without them (the tests). */
export const BUILT_RECORDINGS: RecordingsManifest = typeof __RECORDINGS__ === "undefined" || !__RECORDINGS__ ? { format: 1, tag: "", works: {} } : __RECORDINGS__;

/** Each work's index pin, for the offline key: from the compiled list, so it is the same online, offline, and whether or not this browser can play them. */
export function recordingPins(m: RecordingsManifest): Record<string, string> {
  return Object.fromEntries(Object.entries(m.works).map(([slug, w]) => [slug, w.index]));
}

/** The recordings this page may try to play: none where this browser cannot play either encoding, so every work is made on the device. */
export function playableRecordings(m: RecordingsManifest, format: RecordingFormat | null): Record<string, RecordingEntry> {
  return format ? m.works : {};
}

export const MAX_DECODED_PARTS = 3;
/** A part that fails to arrive is asked for once more after this pause, before the broadcast stops. */
export const PART_RETRY_MS = 800;

/** Whether this browser claims to decode Opus in WebM (canPlayType: a claim, not a guarantee, since some browsers answer yes and still fail to decode a real part). */
function canPlayOpusWebm(): boolean {
  try {
    return typeof OfflineAudioContext !== "undefined" && new Audio().canPlayType('audio/webm; codecs="opus"') !== "";
  } catch {
    return false;
  }
}

/**
 * The format Dial tries first (T5b): Opus where this browser claims to
 * decode it, otherwise m4a (AAC-LC), which iPhone and desktop Safari play.
 * A claim of Opus support that turns out false on the first part falls
 * back to m4a at runtime (nextOnDecodeFailure), before made-on-device.
 */
export function choosePlaybackFormat(): RecordingFormat {
  return canPlayOpusWebm() ? "opus" : "m4a";
}

/**
 * What a decode failure on `format`'s part `partIndex` (0-based) does next,
 * the fallback order Opus, then m4a, then made-on-device (CoS decision H):
 * only an Opus failure on the very first part retries once as m4a (a later
 * Opus part failing, or an m4a failure anywhere, hands over to made-on-device
 * directly). `alreadyRetried` is true once that one retry has been spent.
 */
export function nextOnDecodeFailure(format: RecordingFormat, partIndex: number, alreadyRetried: boolean): "retry-m4a" | "made-here" {
  return format === "opus" && partIndex === 0 && !alreadyRetried ? "retry-m4a" : "made-here";
}

/** A part that arrived intact but that this browser could not decode (the error the page answers by making the work on the device). */
export class RecordingDecodeError extends Error {
  override name = "RecordingDecodeError";
}

/** Whether a failure is this browser failing to decode the audio, not the network or a pin. */
export function isDecodeError(err: unknown): boolean {
  return err instanceof RecordingDecodeError || (err instanceof Error && (err.name === "EncodingError" || err.name === "RecordingDecodeError"));
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Recording {
  private readonly decoded = new Map<number, Promise<Float32Array>>();
  /** Whether the Opus-part-0 retry (nextOnDecodeFailure) has already been spent. */
  private m4aRetried = false;

  constructor(
    readonly slug: string,
    readonly index: RecordingIndex,
    /** The index file as served: its size and SHA-256 (what Save for offline keeps and checks). */
    readonly indexFile: { bytes: number; sha256: string },
    private readonly decode: Decoder = decodeAt24k,
    private readonly fetchPart: (file: string) => Promise<ArrayBuffer> = (file) => fetchRecordingPart(slug, file),
    private readonly retryMs = PART_RETRY_MS,
    /** Which encoding this recording fetches. Mutable: retryAsM4a() moves it after a part-0 Opus retry. */
    public format: RecordingFormat = "opus",
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

  /** This part's pin in the encoding this recording currently fetches. */
  private partPin(p: number): FilePin {
    const part = this.index.parts[p]!;
    return this.format === "m4a" ? part.m4a : part;
  }

  /** A part's bytes, checked against its pin; a failure is tried once more after a short pause. */
  private async fetched(p: number): Promise<ArrayBuffer> {
    const pin = this.partPin(p);
    const namePattern = this.format === "m4a" ? M4A_PART_FILE : PART_FILE;
    if (!namePattern.test(pin.file)) throw new Error(`recording: a part is named ${JSON.stringify(pin.file)}`);
    const once = async () => {
      const bytes = await this.fetchPart(pin.file);
      if (bytes.byteLength !== pin.bytes || (await sha256Hex(bytes)) !== pin.sha256) throw new Error("recording: a part did not match its pin");
      return bytes;
    };
    try {
      return await once();
    } catch {
      await wait(this.retryMs);
      return once();
    }
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
    hit = this.fetched(p).then(async (bytes) => {
      try {
        return await this.decode(bytes);
      } catch (err) {
        throw new RecordingDecodeError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      }
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
    // Once this part is here (so it had the whole connection), the next starts downloading, whichever of its lines was asked for (a seek lands anywhere).
    if (p + 1 < this.index.parts.length) void this.part(p + 1).catch(() => undefined);
    const { from, frames } = lineSlice(this.index, i, RECORDING_RATE, audio.length);
    return toInt16(audio.subarray(from, from + frames));
  }

  /** How many parts are decoded and held (for tests). */
  get held(): number {
    return this.decoded.size;
  }

  /** What a decode failure on part `partIndex` does next (nextOnDecodeFailure), given this recording's own format and retry history. */
  nextOnFailure(partIndex: number): "retry-m4a" | "made-here" {
    return nextOnDecodeFailure(this.format, partIndex, this.m4aRetried);
  }

  /** The one Opus-part-0 retry: switches to m4a and forgets anything already fetched or decoded, so the next samples() re-fetches in the new encoding. */
  retryAsM4a(): void {
    this.format = "m4a";
    this.m4aRetried = true;
    this.decoded.clear();
  }
}

async function fetchRecordingPart(slug: string, file: string): Promise<ArrayBuffer> {
  const res = await fetch(`/recordings/${slug}/${file}`);
  if (!res.ok) throw new Error(`recording part ${file}: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Opens a work's prepared recording, or says why it cannot stand in for a
 * render made here: the index must match its compiled pin, and its lines
 * the text's cues and cast exactly. `null` problem means the recording is usable.
 */
export async function openRecording(
  slug: string,
  entry: RecordingEntry,
  cues: readonly { start: number; end: number; spoken: string; pauseAfterMs: number }[],
  voices: readonly string[],
  format: RecordingFormat = "opus",
): Promise<{ recording: Recording; problem: null } | { recording: null; problem: string }> {
  const res = await fetch(`/recordings/${slug}/index.json`);
  if (!res.ok) throw new Error(`recording index: ${res.status}`);
  const buf = await res.arrayBuffer();
  if ((await sha256Hex(buf)) !== entry.index) return { recording: null, problem: "the index did not match its pin" };
  const index = JSON.parse(new TextDecoder().decode(buf)) as RecordingIndex;
  const problem = indexProblem(index, { slug, digest: await expectedDigest(cues, voices), lines: cues.length, castVersion: CAST_ENGINE_VERSION });
  if (problem) return { recording: null, problem };
  return { recording: new Recording(slug, index, { bytes: buf.byteLength, sha256: entry.index }, undefined, undefined, undefined, format), problem: null };
}
