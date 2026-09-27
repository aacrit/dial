// The render runs here, off the page's thread: each cue is spoken in order,
// in the voice the cast gave it (engine/cast.ts), and its samples are posted
// back. Messages carry only cue text in and
// audio out, plus this worker's own request record (address, time, size)
// for the Seal's log; this worker has no other channel.
//
// The engine (T7, speed/backend.ts): the processor (WASM with threads and
// SIMD) by default, its speed measured from the lines it makes. Where this
// browser offers WebGPU and the graphics chip's model is on this device
// (downloaded only at the listener's choice), the speed test times one
// fixed sentence on both engines, checks the graphics chip speaks it the
// same, and the faster makes the rest. A choice this device measured before
// (speed/store.ts, passed in by the page) is used without testing again.
// Only timings come back to the page; nothing is sent anywhere.

import type { KokoroTTS } from "kokoro-js";
import { dropGpuModel, gpuModelHeld, loadVoice, openVoice, type VoiceManifest } from "./voice";
import type { VoiceId } from "./engine/cast";
import { BENCH_SENTENCE } from "./bench-sentence";
import type { Cue } from "./engine/segment";
import type { Need } from "./voice-cache";
import type { RawEntry } from "./request-log";
import { watchWorkerRequests } from "./worker-requests";
import { entryFor, gpuOffer, keptChoice, keptMatches, pickBackend, shapeOf, soundsRight, type SpeedChoice, type SpeedEntry, type Trial } from "./speed/backend";

/** voices[i] is cue i's cast voice. */
/** from: the first line to make (the lines before it are Dial's recording's, which this browser could not decode). */
/** kept: this device's earlier speed measurement (speed/store.ts), used when its pins still match. */
/** allow: the last line the page lets this worker make yet (chapter-ahead within the memory cap, speed/plan.ts aheadLimit). */
/** gpu: the graphics chip's model is now on this device (the page downloaded it at the listener's choice, its size shown first): test it between two lines. */
export type ToWorker = { type: "render"; cues: Cue[]; voices: VoiceId[]; from?: number; kept?: SpeedEntry | null } | { type: "allow"; upTo: number } | { type: "gpu" };
export type FromWorker =
  /** total: the bytes this visit needs; need: nothing, only this work's voices, or the model and runtime too. */
  | { type: "loading"; loaded: number; total: number; need: Need; missingVoices: number }
  /** The speed test is timing the fixed sentence on each engine. */
  | { type: "testing" }
  /** The engine in use and what to keep on this device (the page keeps it; a worker has no local storage); gpuOffer: the graphics chip's model to offer, in bytes, or 0. */
  | { type: "speed"; choice: SpeedChoice; entry: SpeedEntry; gpuOffer: number }
  | { type: "ready"; kept: boolean }
  /** ms: how long this line took to make, timed here, so the page's measurement never counts its own busy moments. */
  | { type: "cue"; index: number; audio: Float32Array<ArrayBuffer>; sampleRate: number; ms: number }
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
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: object): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter({ powerPreference: "high-performance" }));
  } catch {
    return false;
  }
}

/** A short phrase said once on a fresh engine before it is timed, so the timing is of speech, not of the engine's first start. */
const WARM_UP = "Ready.";

/** Times the fixed sentence on one engine: its speed, and its speech's shape to compare. */
async function timeSentence(tts: KokoroTTS, voice: KokoroVoiceId, warm: boolean) {
  if (warm) await tts.generate(WARM_UP, { voice });
  const t1 = performance.now();
  const raw = await tts.generate(BENCH_SENTENCE, { voice });
  const ms = performance.now() - t1;
  const shape = shapeOf(raw.audio, raw.sampling_rate);
  return { rtf: ms > 0 ? shape.seconds / (ms / 1000) : 0, shape };
}

/**
 * The speed test: the fixed sentence on the processor (the baseline), then
 * on the graphics chip, which counts only if it speaks it the same
 * (speed/backend.ts soundsRight). `cpuWarm`: the processor has already made
 * a line, so it needs no warm-up.
 */
async function speedTest(cpu: KokoroTTS, voice: KokoroVoiceId, manifest: VoiceManifest, cpuWarm: boolean): Promise<{ choice: SpeedChoice; gpuTts: KokoroTTS | null; gpuRtf: number }> {
  const base = await timeSentence(cpu, voice, !cpuWarm);
  const trials: Trial[] = [{ backend: "wasm", rtf: base.rtf, ok: base.shape.finite && base.shape.seconds > 0 }];
  let gpuTts: KokoroTTS | null = null;
  try {
    gpuTts = await openVoice(manifest, "webgpu");
    const g = await timeSentence(gpuTts, voice, true);
    trials.push({ backend: "webgpu", rtf: g.rtf, ok: soundsRight(g.shape, base.shape) });
  } catch {
    trials.push({ backend: "webgpu", rtf: 0, ok: false });
  }
  const choice = pickBackend(trials);
  const gpuTrial = trials[1]!;
  if (choice.backend !== "webgpu" && gpuTts) {
    await release(gpuTts);
    gpuTts = null;
  }
  return { choice, gpuTts, gpuRtf: gpuTrial.ok ? gpuTrial.rtf : 0 };
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
/** The graphics chip's model arrived on this device (the page downloaded it at the listener's choice): test it between two lines. */
let gpuArrived = false;

ctx.onmessage = async (event) => {
  if (event.data.type === "allow") {
    allowed = event.data.upTo;
    wake?.();
    wake = null;
    return;
  }
  if (event.data.type === "gpu") {
    gpuArrived = true;
    return;
  }
  if (event.data.type !== "render") return;
  try {
    const { cues, voices } = event.data;
    const from = Math.max(0, Math.min(cues.length, event.data.from ?? 0));
    // Only the voices this work's cast uses are fetched and kept.
    const { tts, manifest, kept } = await loadVoice([...new Set(voices)], (loaded, total, need, missingVoices) => ctx.postMessage({ type: "loading", loaded, total, need, missingVoices }));
    flushRequests();
    const gpu = await hasGpu();
    const pins = { model: manifest.sha256, runtime: manifest.runtimeSha256 };
    const prior = event.data.kept ?? null;
    const entry = keptMatches(prior, pins, gpu) ? prior : null;
    const held = gpu && (await gpuModelHeld(manifest));
    const voiceAt = (i: number) => (voices[i] ?? voices[0]) as KokoroVoiceId;

    // The engine: this device's earlier choice where it still holds, else the processor, measured from its first lines.
    let choice: SpeedChoice = keptChoice(entry, pins, gpu) ?? { backend: "wasm", rtf: 0, trials: [], cached: false };
    let engine: KokoroTTS = tts;
    let gpuRtf = entry?.gpuRtf;
    if (choice.backend === "webgpu") {
      try {
        if (!held) throw new Error("the graphics chip's model is not on this device");
        engine = await openVoice(manifest, "webgpu");
      } catch {
        choice = { backend: "wasm", rtf: 0, trials: [], cached: false };
        gpuRtf = undefined;
      }
    }
    // The model is here but this graphics chip was never tested: test it now, before the first line.
    const test = async (cpuWarm: boolean, at: number) => {
      ctx.postMessage({ type: "testing" });
      const tested = await speedTest(tts, voiceAt(at), manifest, cpuWarm);
      choice = tested.choice;
      gpuRtf = tested.gpuRtf;
      engine = tested.gpuTts ?? tts;
      // Lost to the processor, or spoke wrongly: its model would only take space.
      if (!tested.gpuTts) await dropGpuModel(manifest);
      ctx.postMessage({ type: "speed", choice, entry: entryFor(choice, pins, gpu, gpuRtf), gpuOffer: 0 });
    };
    if (held && gpuRtf === undefined && choice.backend === "wasm") await test(false, from);
    else ctx.postMessage({ type: "speed", choice, entry: entryFor(choice, pins, gpu, gpuRtf), gpuOffer: gpuOffer(gpu, manifest.gpu?.bytes, held, entry) });
    ctx.postMessage({ type: "ready", kept });

    let tested = held;
    for (let i = from; i < cues.length; i++) {
      // Only a voice the manifest pins, and so the loader has checked, is ever used.
      const voice = voices[i] as KokoroVoiceId | undefined;
      if (!voice || !Object.hasOwn(manifest.voices, voice)) throw new Error(`voice: no pinned voice for line ${i + 1}`);
      // Far enough ahead of the listener: wait until the page allows more.
      while (i > allowed) await new Promise<void>((resolve) => (wake = resolve));
      // The graphics chip's model arrived at the listener's choice: test it between two lines.
      if (gpuArrived && !tested) {
        tested = true;
        await test(i > from, i);
      }
      let raw;
      let t0 = performance.now();
      try {
        raw = await engine.generate(cues[i]!.spoken, { voice });
      } catch (err) {
        // The browser stopped the graphics chip (a lost device): the processor carries on from this line, and the page is told.
        if (engine === tts) throw err;
        await release(engine);
        engine = tts;
        const cpu: SpeedChoice = { backend: "wasm", rtf: choice.trials.find((t) => t.backend === "wasm")?.rtf ?? 0, trials: [], cached: false };
        choice = cpu;
        // Kept as measured without the graphics chip, so the next visit starts on the processor and may test again.
        ctx.postMessage({ type: "speed", choice: cpu, entry: entryFor(cpu, pins, false), gpuOffer: 0 });
        t0 = performance.now();
        raw = await engine.generate(cues[i]!.spoken, { voice });
      }
      const ms = performance.now() - t0;
      const audio = raw.audio as Float32Array<ArrayBuffer>;
      ctx.postMessage({ type: "cue", index: i, audio, sampleRate: raw.sampling_rate, ms }, [audio.buffer]);
    }
    flushRequests();
    ctx.postMessage({ type: "done" });
  } catch (err) {
    flushRequests();
    ctx.postMessage({ type: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
};
