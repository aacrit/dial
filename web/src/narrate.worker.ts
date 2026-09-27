// The render runs here, off the page's thread: each cue is spoken in order,
// in the voice the cast gave it (engine/cast.ts), and its samples are posted
// back. Messages carry only cue text in and
// audio out, plus this worker's own request record (address, time, size)
// for the Seal's log; this worker has no other channel.
//
// The Seal's speed test runs here too ("bench"), so the speech runtime ships
// once: load the voice (the radio's own loader and byte counts), then time
// one fixed sentence on the processor. Only timings come back; nothing is
// sent anywhere.

import type { KokoroTTS } from "kokoro-js";
import { loadVoice } from "./voice";
import type { VoiceId } from "./engine/cast";
import { BENCH_SENTENCE } from "./bench-sentence";
import type { Cue } from "./engine/segment";
import type { Need } from "./voice-cache";
import type { RawEntry } from "./request-log";
import { watchWorkerRequests } from "./worker-requests";

/** voices[i] is cue i's cast voice. */
/** bench: the Seal's speed test, in the voice it names (the narrator), so this worker never loads the voice table. */
export type ToWorker = { type: "render"; cues: Cue[]; voices: VoiceId[] } | { type: "bench"; voice: VoiceId };
export type FromWorker =
  /** total: the bytes this visit needs; need: nothing, only this work's voices, or the model and runtime too. */
  | { type: "loading"; loaded: number; total: number; need: Need; missingVoices: number }
  | { type: "ready"; kept: boolean }
  | { type: "cue"; index: number; audio: Float32Array<ArrayBuffer>; sampleRate: number }
  | { type: "done" }
  | { type: "error"; message: string }
  /** This worker's requests, from its own Resource Timing record (worker-requests.ts). */
  | { type: "requests"; entries: RawEntry[] };

/** The speed test's messages (the Seal's). */
export type FromBench =
  | { type: "loading"; loaded: number; total: number; need: Need; missingVoices: number }
  /** The voice is ready; the sentence is being timed. */
  | { type: "timing" }
  /** firstMs: the sentence's making time; audioSeconds: the speech it made. The page times the voice load itself. */
  | { type: "result"; firstMs: number; audioSeconds: number }
  | { type: "error"; message: string }
  | { type: "requests"; entries: RawEntry[] };

/** The ids kokoro-js knows; the cast only ever holds ids from design/voices.json, which is measured from the same files. */
type KokoroVoiceId = NonNullable<NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"]>;

const ctx = self as unknown as {
  postMessage(message: FromWorker | FromBench, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

const flushRequests = watchWorkerRequests((entries) => ctx.postMessage({ type: "requests", entries }));

async function bench(voice: KokoroVoiceId): Promise<void> {
  const { tts } = await loadVoice([voice], (loaded, total, need, missingVoices) => ctx.postMessage({ type: "loading", loaded, total, need, missingVoices }));
  flushRequests();
  ctx.postMessage({ type: "timing" });
  const t1 = performance.now();
  const raw = await tts.generate(BENCH_SENTENCE, { voice });
  const t2 = performance.now();
  flushRequests();
  ctx.postMessage({ type: "result", firstMs: t2 - t1, audioSeconds: raw.audio.length / raw.sampling_rate });
}

ctx.onmessage = async (event) => {
  if (event.data.type === "bench") {
    try {
      await bench(event.data.voice as KokoroVoiceId);
    } catch (err) {
      flushRequests();
      ctx.postMessage({ type: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
    return;
  }
  if (event.data.type !== "render") return;
  try {
    const { cues, voices } = event.data;
    // Only the voices this work's cast uses are fetched and kept.
    const { tts, manifest, kept } = await loadVoice([...new Set(voices)], (loaded, total, need, missingVoices) => ctx.postMessage({ type: "loading", loaded, total, need, missingVoices }));
    flushRequests();
    ctx.postMessage({ type: "ready", kept });
    for (let i = 0; i < cues.length; i++) {
      // Only a voice the manifest pins, and so the loader has checked, is ever used.
      const voice = voices[i] as KokoroVoiceId | undefined;
      if (!voice || !Object.hasOwn(manifest.voices, voice)) throw new Error(`voice: no pinned voice for line ${i + 1}`);
      const raw = await tts.generate(cues[i]!.spoken, { voice });
      const audio = raw.audio as Float32Array<ArrayBuffer>;
      ctx.postMessage({ type: "cue", index: i, audio, sampleRate: raw.sampling_rate }, [audio.buffer]);
    }
    flushRequests();
    ctx.postMessage({ type: "done" });
  } catch (err) {
    flushRequests();
    ctx.postMessage({ type: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
};
