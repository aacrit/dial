// The render worker's loop (narrate.worker.ts runs it; tests drive it with
// fake engines): each cue is spoken in order, in the voice the cast gave it,
// on the engine the speed test chose (speed/backend.ts), and its samples are
// posted back with the time it took.
//
// The engine: the processor (WASM, q8) by default, its speed measured from
// the lines it makes. Where the browser offers WebGPU and the graphics
// chip's model is on this device (the page downloads it only at the
// listener's choice), the speed test times one fixed sentence on both
// engines, keeps the graphics chip only if it is faster and says the
// sentence the same, and otherwise deletes its model. A visit on a device
// that chose its graphics chip before opens no processor session at all
// (its memory); should the browser stop the graphics chip (an error, or no
// answer within its watchdog), this worker says so and stops, and the page
// starts a fresh worker that carries on from that line on the processor
// (main.ts, "lost"). On the visit of the test both
// sessions stay open: letting the processor's go while the graphics chip
// runs breaks onnxruntime-web's WebGPU ("no GPU data for input", measured
// in the T7 review), so its memory is freed from the next visit on. A choice this device measured before (kept by
// the page, speed/store.ts) is used without testing again. Only timings
// come back; nothing is sent anywhere, and this loop never downloads the
// graphics chip's model itself.

import { BENCH_SENTENCE } from "../bench-sentence";
import type { VoiceId } from "../engine/cast";
import type { Cue } from "../engine/segment";
import type { RawEntry } from "../request-log";
import type { Need } from "../voice-cache";
import { entryFor, gpuOffer, keptChoice, keptMatches, pickBackend, shapeOf, soundsRight, type Backend, type SpeedChoice, type SpeedEntry, type Trial } from "./backend";

/** voices[i] is cue i's cast voice. */
/** from: the first line to make (the lines before it are Dial's recording's, which this browser could not decode). */
/** kept: this device's earlier speed measurement (speed/store.ts), used when its pins still match. */
/** allow: the last line the page lets this worker make yet (chapter-ahead within the memory cap, speed/plan.ts aheadLimit). */
/** gpu: the graphics chip's model is now on this device (the page downloaded it at the listener's choice, its size shown first): test it between two lines. */
export type ToWorker = { type: "render"; cues: Cue[]; voices: VoiceId[]; from?: number; kept?: SpeedEntry | null } | { type: "allow"; upTo: number } | { type: "gpu" };
export type FromWorker =
  /** total: the bytes this visit needs; need: nothing, only this work's voices, or the model and runtime too. */
  | { type: "loading"; loaded: number; total: number; need: Need; missingVoices: number }
  /** The speed test is timing the fixed sentence on each engine: the making pauses for it. */
  | { type: "testing" }
  /** The engine in use and what to keep on this device (the page keeps it; a worker has no local storage); gpuOffer: the graphics chip's model to offer, in bytes, or 0. */
  | { type: "speed"; choice: SpeedChoice; entry: SpeedEntry; gpuOffer: number }
  | { type: "ready"; kept: boolean }
  /** ms: how long this line took to make, timed here, so the page's measurement never counts its own busy moments. */
  | { type: "cue"; index: number; audio: Float32Array<ArrayBuffer>; sampleRate: number; ms: number }
  | { type: "done" }
  /** The browser stopped the graphics chip at line `index`: the page carries on in a fresh worker, with `kept` (the processor, no test). */
  | { type: "lost"; index: number; kept: SpeedEntry }
  | { type: "error"; message: string }
  /** This worker's requests, from its own Resource Timing record (worker-requests.ts). */
  | { type: "requests"; entries: RawEntry[] };

/** One engine's session: what the loop needs of kokoro-js's KokoroTTS. */
export interface Speaker {
  generate(text: string, options: { voice: never }): Promise<{ audio: Float32Array; sampling_rate: number }>;
  model: { dispose(): unknown };
}

export interface LoopManifest {
  sha256: string;
  runtimeSha256: string;
  voices: Record<string, string>;
  gpu?: { bytes: number };
}

/** Everything the loop touches outside itself, injected (narrate.worker.ts passes the real ones). */
export interface LoopDeps<M extends LoopManifest> {
  /** openCpu false: no processor session (this visit expects to run on the graphics chip). */
  loadVoice(voices: string[], onProgress: (loaded: number, total: number, need: Need, missingVoices: number) => void, openCpu: boolean): Promise<{ tts: Speaker | null; manifest: M; kept: boolean }>;
  openVoice(manifest: M, backend: Backend): Promise<Speaker>;
  gpuModelHeld(manifest: M): Promise<boolean>;
  dropGpuModel(manifest: M): Promise<void>;
  hasGpu(): Promise<boolean>;
  post(message: FromWorker, transfer?: Transferable[]): void;
  flushRequests(): void;
  /** One turn of the event loop, so the page's messages come in between lines. */
  turn(): Promise<void>;
  /** Resolves after `ms` (the graphics chip's watchdog). */
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * How long a line may take on the graphics chip before it counts as
 * stopped: a lost GPU process can leave the call unanswered for ever rather
 * than failing (measured: Chromium's GPU process crashed mid-work). Five
 * times real time for the line's words at 150 a minute, and never under 15 s.
 */
export function gpuWatchdogMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(15_000, ((words / 150) * 60 * 5) * 1000);
}

/** A short phrase said once on a fresh engine before it is timed, so the timing is of speech, not of the engine's first start. */
export const WARM_UP = "Ready.";

const say = (tts: Speaker, text: string, voice: string) => tts.generate(text, { voice: voice as never });

type Guard = <T>(p: Promise<T>, text: string) => Promise<T>;

/** Times the fixed sentence on one engine: its speed, and its speech's shape to compare; `guard` bounds each call (the graphics chip's watchdog). */
async function timeSentence(tts: Speaker, voice: string, warm: boolean, now: () => number, guard: Guard = (p) => p) {
  if (warm) await guard(say(tts, WARM_UP, voice), WARM_UP);
  const t1 = now();
  const raw = await guard(say(tts, BENCH_SENTENCE, voice), BENCH_SENTENCE);
  const ms = now() - t1;
  const shape = shapeOf(raw.audio, raw.sampling_rate);
  return { rtf: ms > 0 ? shape.seconds / (ms / 1000) : 0, shape };
}

async function release(tts: Speaker | null): Promise<void> {
  try {
    await tts?.model.dispose();
  } catch {
    // Already gone.
  }
}

/**
 * The speed test: the fixed sentence on the processor (the baseline), then
 * on the graphics chip, which counts only if it speaks it the same. The
 * loser's session goes; a graphics chip that lost, or spoke wrongly, has its
 * model deleted from this device.
 */
export async function speedTest<M extends LoopManifest>(deps: LoopDeps<M>, cpu: Speaker, voice: string, manifest: M, cpuWarm: boolean): Promise<{ choice: SpeedChoice; gpuTts: Speaker | null; gpuRtf: number; stuck: boolean }> {
  const base = await timeSentence(cpu, voice, !cpuWarm, deps.now);
  const trials: Trial[] = [{ backend: "wasm", rtf: base.rtf, ok: base.shape.finite && base.shape.seconds > 0 }];
  let gpuTts: Speaker | null = null;
  let stuck = false;
  try {
    // Every step on the graphics chip is bounded: a GPU that never answers must not freeze the work.
    gpuTts = await bounded(deps, deps.openVoice(manifest, "webgpu"), GPU_OPEN_MS);
    const g = await timeSentence(gpuTts, voice, true, deps.now, (p, text) => bounded(deps, p, gpuWatchdogMs(text)));
    trials.push({ backend: "webgpu", rtf: g.rtf, ok: soundsRight(g.shape, base.shape) });
  } catch (err) {
    stuck = err instanceof GpuStuckError;
    trials.push({ backend: "webgpu", rtf: 0, ok: false });
  }
  const choice = pickBackend(trials);
  const gpuTrial = trials[1]!;
  if (choice.backend !== "webgpu") {
    // A stuck session may never answer its release either: let it go without waiting.
    if (stuck) void release(gpuTts);
    else await release(gpuTts);
    gpuTts = null;
    await deps.dropGpuModel(manifest);
  }
  return { choice, gpuTts, gpuRtf: gpuTrial.ok ? gpuTrial.rtf : 0, stuck };
}

/** The graphics chip's session may take this long to open (the 326 MB model's first start included) before it counts as stuck. */
export const GPU_OPEN_MS = 60_000;

/** The graphics chip did not answer in time. */
export class GpuStuckError extends Error {
  override name = "GPUDeviceLostError";
}

/** `p`, or GpuStuckError once `ms` pass first. */
export function bounded<T, M extends LoopManifest>(deps: Pick<LoopDeps<M>, "sleep">, p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    deps.sleep(ms).then(() => {
      throw new GpuStuckError("the graphics chip stopped answering");
    }),
  ]);
}

/** One render: the page's messages come in through onMessage while render() runs. */
export class RenderLoop<M extends LoopManifest> {
  /** The last line this worker may make yet, and the loop waiting for more. */
  private allowed = Infinity;
  private wake: (() => void) | null = null;
  /** The graphics chip's model arrived on this device at the listener's choice. */
  private gpuArrived = false;

  constructor(private readonly deps: LoopDeps<M>) {}

  onMessage(data: ToWorker): void {
    if (data.type === "allow") {
      this.allowed = data.upTo;
      this.wake?.();
      this.wake = null;
    } else if (data.type === "gpu") {
      this.gpuArrived = true;
    } else if (data.type === "render") {
      void this.render(data);
    }
  }

  async render(data: Extract<ToWorker, { type: "render" }>): Promise<void> {
    const d = this.deps;
    try {
      const { cues, voices } = data;
      const from = Math.max(0, Math.min(cues.length, data.from ?? 0));
      // Only the voices this work's cast uses are fetched and kept.
      // A device that chose its graphics chip before loads no processor session: two sessions are not held at once,
      // and letting one go while the other runs breaks onnxruntime-web's WebGPU (measured, T7 review).
      const wantGpu = data.kept?.backend === "webgpu";
      const { tts, manifest, kept } = await d.loadVoice([...new Set(voices)], (loaded, total, need, missingVoices) => d.post({ type: "loading", loaded, total, need, missingVoices }), !wantGpu);
      d.flushRequests();
      const gpu = await d.hasGpu();
      const pins = { model: manifest.sha256, runtime: manifest.runtimeSha256 };
      const prior = data.kept ?? null;
      const entry = keptMatches(prior, pins, gpu) ? prior : null;
      // Checked even without WebGPU, so a copy under an older pin is deleted (voice.ts gpuModelHeld).
      const held = (await d.gpuModelHeld(manifest)) && gpu;
      const voiceAt = (i: number) => voices[i] ?? voices[0]!;

      // The engine: this device's earlier choice where it still holds, else the processor, measured from its first lines.
      let cpu: Speaker | null = tts;
      let choice: SpeedChoice = keptChoice(entry, pins, gpu) ?? { backend: "wasm", rtf: 0, trials: [], cached: false };
      let gpuRtf = entry?.gpuRtf;
      let engine: Speaker | null = null;
      /**
       * The graphics chip failed or stopped answering at line `at`: its runtime cannot be trusted any more, so
       * this worker says so and stops, and the page carries on in a fresh worker on the processor, untested.
       */
      const lose = (at: number) => {
        const fallback: SpeedChoice = { backend: "wasm", rtf: choice.trials.find((t) => t.backend === "wasm")?.rtf ?? 0, trials: [], cached: false };
        // Kept as measured without the graphics chip, so the next visit starts on the processor and may test again.
        d.post({ type: "speed", choice: fallback, entry: entryFor(fallback, pins, false), gpuOffer: 0 });
        d.post({ type: "lost", index: at, kept: entryFor(fallback, pins, gpu, gpuRtf ?? 0) });
      };
      if (choice.backend === "webgpu") {
        if (!held) {
          // Its model is gone (cleared site data): the processor, and the graphics chip was never touched.
          choice = { backend: "wasm", rtf: 0, trials: [], cached: false };
          gpuRtf = undefined;
        } else {
          try {
            engine = await bounded(d, d.openVoice(manifest, "webgpu"), GPU_OPEN_MS);
          } catch {
            // It would not open, or never answered: its model goes, and a fresh worker carries on.
            await d.dropGpuModel(manifest);
            lose(from);
            return;
          }
        }
      }
      // On the processor: its session, opened now if this visit had expected the graphics chip.
      if (!engine) {
        cpu ??= await d.openVoice(manifest, "wasm");
        engine = cpu;
      }
      /** Runs the speed test; false when the graphics chip got stuck in it (then the work goes on in a fresh worker). */
      const test = async (cpuWarm: boolean, at: number): Promise<boolean> => {
        d.post({ type: "testing" });
        const tested = await speedTest(d, cpu!, voiceAt(at), manifest, cpuWarm);
        choice = tested.choice;
        gpuRtf = tested.gpuRtf;
        if (tested.stuck) {
          lose(at);
          return false;
        }
        engine = tested.gpuTts ?? cpu!;
        d.post({ type: "speed", choice, entry: entryFor(choice, pins, gpu, gpuRtf), gpuOffer: 0 });
        return true;
      };
      // The model is here but this graphics chip was never tested: test it now, before the first line.
      if (held && gpuRtf === undefined && choice.backend === "wasm") {
        if (!(await test(false, from))) return;
      } else d.post({ type: "speed", choice, entry: entryFor(choice, pins, gpu, gpuRtf), gpuOffer: gpuOffer(gpu, manifest.gpu?.bytes, held, entry) });
      // Measured from its first line: say a short phrase first, so that line times speech, not the engine's first start.
      if (!(choice.rtf > 0)) await say(engine, WARM_UP, voiceAt(from));
      d.post({ type: "ready", kept });

      let tested = held;
      for (let i = from; i < cues.length; i++) {
        // Only a voice the manifest pins, and so the loader has checked, is ever used.
        const voice = voices[i];
        if (!voice || !Object.hasOwn(manifest.voices, voice)) throw new Error(`voice: no pinned voice for line ${i + 1}`);
        // Between two lines, let the page's messages in (the allowance, the graphics chip's model): making a
        // line awaits only promises, so without a turn of the event loop they would wait until the work is made.
        await d.turn();
        // Far enough ahead of the listener: wait until the page allows more.
        while (i > this.allowed) await new Promise<void>((resolve) => (this.wake = resolve));
        // The graphics chip's model arrived at the listener's choice: test it between two lines (the page sends
        // it only while playback waits or is well ahead, so the test's pause is never heard).
        if (this.gpuArrived && !tested) {
          tested = true;
          if (!(await test(i > from, i))) return;
        }
        let raw;
        const t0 = d.now();
        try {
          const line = engine.generate(cues[i]!.spoken, { voice: voice as never });
          // The processor always answers; the graphics chip gets a watchdog.
          raw = engine === cpu ? await line : await bounded(d, line, gpuWatchdogMs(cues[i]!.spoken));
        } catch (err) {
          // The browser stopped the graphics chip (a lost device, or no answer): the page is told, and a fresh
          // worker carries on from this line on the processor (this worker's runtime shares its state with the
          // lost graphics chip: after a crashed GPU process its processor session made nothing more, measured).
          if (engine === cpu) throw err;
          // Let the stopped session go without waiting on it: a lost device may never answer that either.
          void release(engine);
          lose(i);
          return;
        }
        const ms = d.now() - t0;
        const audio = raw.audio as Float32Array<ArrayBuffer>;
        d.post({ type: "cue", index: i, audio, sampleRate: raw.sampling_rate, ms }, [audio.buffer]);
      }
      d.flushRequests();
      d.post({ type: "done" });
    } catch (err) {
      d.flushRequests();
      d.post({ type: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
  }
}
