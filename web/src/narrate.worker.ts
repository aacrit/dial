// The render runs here, off the page's thread: each cue is spoken in order,
// in the voice the cast gave it (engine/cast.ts), and its samples are posted
// back. Messages carry only cue text in and
// audio out, plus this worker's own request record (address, time, size)
// for the Seal's log; this worker has no other channel.
//
// Before the first line, the speed test (T7, speed/backend.ts) picks the
// engine that makes the speech: it times one fixed sentence on the
// processor and, where this browser offers WebGPU, on the graphics chip,
// through the same pinned model and runtime (nothing more is downloaded).
// Only timings come back to the page; nothing is sent anywhere. A choice
// this device measured before (speed/store.ts, passed in by the page) skips
// the test.

import type { KokoroTTS } from "kokoro-js";
import { loadVoice, openVoice, type VoiceManifest } from "./voice";
import type { VoiceId } from "./engine/cast";
import { BENCH_SENTENCE } from "./bench-sentence";
import type { Cue } from "./engine/segment";
import type { Need } from "./voice-cache";
import type { RawEntry } from "./request-log";
import { watchWorkerRequests } from "./worker-requests";
import { entryFor, keptChoice, pickBackend, shapeOf, soundsRight, type Backend, type SpeedChoice, type SpeedEntry, type Trial } from "./speed/backend";

/** voices[i] is cue i's cast voice. */
/** from: the first line to make (the lines before it are Dial's recording's, which this browser could not decode). */
/** kept: this device's earlier speed measurement (speed/store.ts), used when its pins still match. */
/** allow: the last line the page lets this worker make yet (chapter-ahead within the memory cap, speed/plan.ts aheadLimit). */
export type ToWorker = { type: "render"; cues: Cue[]; voices: VoiceId[]; from?: number; kept?: SpeedEntry | null } | { type: "allow"; upTo: number };
export type FromWorker =
  /** total: the bytes this visit needs; need: nothing, only this work's voices, or the model and runtime too. */
  | { type: "loading"; loaded: number; total: number; need: Need; missingVoices: number }
  /** The voice is loaded; the speed test is timing the fixed sentence on each engine. */
  | { type: "testing" }
  /** The engine chosen, and what to keep on this device (the page keeps it; a worker has no local storage). */
  | { type: "speed"; choice: SpeedChoice; entry: SpeedEntry }
  | { type: "ready"; kept: boolean }
  | { type: "cue"; index: number; audio: Float32Array<ArrayBuffer>; sampleRate: number }
  | { type: "done" }
  | { type: "error"; message: string }
  /** This worker's requests, from its own Resource Timing record (worker-requests.ts). */
  | { type: "requests"; entries: RawEntry[] };

/** The ids kokoro-js knows; the cast only ever holds ids from design/voices.json, which is measured from the same files. */
type KokoroVoiceId = NonNullable<NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"]>;

const ctx = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

const flushRequests = watchWorkerRequests((entries) => ctx.postMessage({ type: "requests", entries }));

/** Whether this browser offers WebGPU to a worker, with an adapter behind it. */
async function hasGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** A short phrase said once on a fresh engine before it is timed, so the timing is of speech, not of the engine's first start. */
const WARM_UP = "Ready.";

/** Times the fixed sentence on one engine: its speed, and its speech's shape to compare. */
async function timeSentence(tts: KokoroTTS, voice: KokoroVoiceId) {
  await tts.generate(WARM_UP, { voice });
  const t1 = performance.now();
  const raw = await tts.generate(BENCH_SENTENCE, { voice });
  const ms = performance.now() - t1;
  const shape = shapeOf(raw.audio, raw.sampling_rate);
  return { rtf: ms > 0 ? shape.seconds / (ms / 1000) : 0, shape };
}

/**
 * The speed test: the processor first (the baseline, always there), then
 * the graphics chip where offered. The graphics chip counts only if its
 * speech matches the processor's (speed/backend.ts soundsRight).
 */
async function speedTest(cpu: KokoroTTS, voice: KokoroVoiceId, manifest: VoiceManifest, gpu: boolean): Promise<{ choice: SpeedChoice; gpuTts: KokoroTTS | null }> {
  const base = await timeSentence(cpu, voice);
  const trials: Trial[] = [{ backend: "wasm", rtf: base.rtf, ok: base.shape.finite && base.shape.seconds > 0 }];
  let gpuTts: KokoroTTS | null = null;
  if (gpu) {
    try {
      gpuTts = await openVoice(manifest, "webgpu");
      const g = await timeSentence(gpuTts, voice);
      trials.push({ backend: "webgpu", rtf: g.rtf, ok: soundsRight(g.shape, base.shape) });
    } catch {
      trials.push({ backend: "webgpu", rtf: 0, ok: false });
    }
  }
  const choice = pickBackend(trials);
  if (choice.backend !== "webgpu" && gpuTts) {
    await release(gpuTts);
    gpuTts = null;
  }
  return { choice, gpuTts };
}

/** Lets an engine's model go (its memory on the graphics chip too). */
async function release(tts: KokoroTTS): Promise<void> {
  try {
    await tts.model.dispose();
  } catch {
    // Already gone.
  }
}

/** The last line this worker may make yet, and the loop waiting for more. */
let allowed = Infinity;
let wake: (() => void) | null = null;

ctx.onmessage = async (event) => {
  if (event.data.type === "allow") {
    allowed = event.data.upTo;
    wake?.();
    wake = null;
    return;
  }
  if (event.data.type !== "render") return;
  try {
    const { cues, voices } = event.data;
    const from = Math.max(0, Math.min(cues.length, event.data.from ?? 0));
    // Only the voices this work's cast uses are fetched and kept.
    const { tts, manifest, kept } = await loadVoice([...new Set(voices)], (loaded, total, need, missingVoices) => ctx.postMessage({ type: "loading", loaded, total, need, missingVoices }));
    flushRequests();
    // The engine: this device's earlier measurement where its pins still match, else the speed test, in the voice of the first line to make.
    const gpu = await hasGpu();
    const pins = { model: manifest.sha256, runtime: manifest.runtimeSha256 };
    let choice = keptChoice(event.data.kept ?? null, pins, gpu);
    let engine: KokoroTTS = tts;
    if (choice?.backend === "webgpu") {
      try {
        engine = await openVoice(manifest, "webgpu");
      } catch {
        choice = null;
      }
    }
    if (!choice) {
      ctx.postMessage({ type: "testing" });
      const tested = await speedTest(tts, (voices[from] ?? voices[0]) as KokoroVoiceId, manifest, gpu);
      choice = tested.choice;
      engine = tested.gpuTts ?? tts;
    }
    ctx.postMessage({ type: "speed", choice, entry: entryFor(choice, pins, gpu) });
    ctx.postMessage({ type: "ready", kept });
    let backend: Backend = choice.backend;
    for (let i = from; i < cues.length; i++) {
      // Only a voice the manifest pins, and so the loader has checked, is ever used.
      const voice = voices[i] as KokoroVoiceId | undefined;
      if (!voice || !Object.hasOwn(manifest.voices, voice)) throw new Error(`voice: no pinned voice for line ${i + 1}`);
      // Far enough ahead of the listener: wait until the page allows more.
      while (i > allowed) await new Promise<void>((resolve) => (wake = resolve));
      let raw;
      try {
        raw = await engine.generate(cues[i]!.spoken, { voice });
      } catch (err) {
        // The browser stopped the graphics chip (a lost device): the processor carries on from this line, and the page is told.
        if (backend !== "webgpu") throw err;
        await release(engine);
        engine = tts;
        backend = "wasm";
        const cpu: SpeedChoice = { backend, rtf: choice.trials.find((t) => t.backend === "wasm")?.rtf ?? 0, trials: [], cached: false };
        // Kept as measured without the graphics chip, so the next visit tests again.
        ctx.postMessage({ type: "speed", choice: cpu, entry: entryFor(cpu, pins, false) });
        raw = await engine.generate(cues[i]!.spoken, { voice });
      }
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
