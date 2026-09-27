// Which of this device's engines makes the speech (T7): the processor
// (onnxruntime-web's WASM with threads and SIMD, the baseline, running the
// q8 model) or the graphics chip (WebGPU, through the same pinned runtime:
// its .jsep build carries both, running the fp32 model, because q8's
// quantized operators fall back to the processor on WebGPU and fp16 does
// not speak right there). Measured, never assumed: the processor's speed
// comes from the lines it makes; where the graphics chip's model is on this
// device (downloaded only at the listener's choice), the render worker times
// one fixed sentence on both engines (narrate.worker.ts speedTest), checks
// the graphics chip's speech against the processor's (soundsRight), and the
// faster one that sounds right makes the work. The choice and its measured
// speed are kept on this device only (speed/store.ts), keyed to the model's
// and the runtime's pins, so a new voice or runtime is measured afresh.
// Nothing here is ever sent: not the speeds, not the engine, not a count.
//
// WebNN is not offered: onnxruntime-web's WebNN provider needs a browser
// flag in every shipping browser today, so it is future work, measured the
// same way once it ships.
//
// Pure: no DOM, no storage, no clock. The worker and the page both import it.

export type Backend = "wasm" | "webgpu";

/** One engine's timing of the fixed sentence. */
export interface Trial {
  backend: Backend;
  /** Real-time factor: seconds of speech made per second of work (0 when it failed). */
  rtf: number;
  /** It ran, and its speech matches the processor's (soundsRight). */
  ok: boolean;
}

/** The engine chosen for this device, and the speed it was measured at. */
export interface SpeedChoice {
  backend: Backend;
  rtf: number;
  /** Every engine that was timed this time; empty when the choice came from this device's earlier measurement. */
  trials: Trial[];
  /** From this device's earlier measurement (speed/store.ts), not timed now. */
  cached: boolean;
}

/** What is kept on this device (speed/store.ts), one entry under one key. */
export interface SpeedEntry {
  v: 1;
  /** The pins it was measured with: another model or runtime is measured afresh. */
  model: string;
  runtime: string;
  /** Whether this browser offered WebGPU when it was measured: a change is measured afresh. */
  gpu: boolean;
  backend: Backend;
  rtf: number;
  /** The graphics chip's measured speed once it was tested (0 when it did not speak right), so it is not offered again. */
  gpuRtf?: number;
}

/**
 * The graphics chip's model to offer, in bytes, or 0: only where this
 * browser offers WebGPU, the model is not on this device yet, and this
 * device's graphics chip has not been tested before.
 */
export function gpuOffer(gpu: boolean, bytes: number | undefined, held: boolean, entry: SpeedEntry | null): number {
  if (!gpu || held || !(bytes && bytes > 0)) return 0;
  return entry?.gpuRtf !== undefined ? 0 : bytes;
}

/** Reads a kept entry; anything malformed is treated as none. */
export function parseEntry(raw: string | null | undefined): SpeedEntry | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Partial<SpeedEntry>;
    if (e.v !== 1 || typeof e.model !== "string" || typeof e.runtime !== "string" || typeof e.gpu !== "boolean") return null;
    if ((e.backend !== "wasm" && e.backend !== "webgpu") || typeof e.rtf !== "number" || !(e.rtf > 0) || !Number.isFinite(e.rtf)) return null;
    const gpuRtf = typeof e.gpuRtf === "number" && e.gpuRtf >= 0 && Number.isFinite(e.gpuRtf) ? { gpuRtf: e.gpuRtf } : {};
    return { v: 1, model: e.model, runtime: e.runtime, gpu: e.gpu, backend: e.backend, rtf: e.rtf, ...gpuRtf };
  } catch {
    return null;
  }
}

/** The kept choice, when it was measured with these pins and this browser's WebGPU as it is now; else null (measure again). */
export function keptChoice(entry: SpeedEntry | null, pins: { model: string; runtime: string }, gpu: boolean): SpeedChoice | null {
  if (!keptMatches(entry, pins, gpu)) return null;
  return { backend: entry!.backend, rtf: entry!.rtf, trials: [], cached: true };
}

/** The kept entry was measured with these pins and this browser's WebGPU as it is now. */
export function keptMatches(entry: SpeedEntry | null, pins: { model: string; runtime: string }, gpu: boolean): boolean {
  if (!entry || entry.model !== pins.model || entry.runtime !== pins.runtime || entry.gpu !== gpu) return false;
  return entry.backend !== "webgpu" || gpu;
}

/** The entry to keep for a choice (its rtf may still be 0: the page keeps it once a line has measured it). */
export function entryFor(choice: SpeedChoice, pins: { model: string; runtime: string }, gpu: boolean, gpuRtf?: number): SpeedEntry {
  return { v: 1, model: pins.model, runtime: pins.runtime, gpu, backend: choice.backend, rtf: choice.rtf, ...(gpuRtf !== undefined ? { gpuRtf } : {}) };
}

/** The entry with the speed measured live from the lines made, where it is a measurement; null when there is nothing to keep yet. */
export function measuredEntry(entry: SpeedEntry | null, backend: Backend, rtf: number): SpeedEntry | null {
  if (!entry || entry.backend !== backend || !(rtf > 0) || !Number.isFinite(rtf)) return null;
  return { ...entry, rtf };
}

/** The fastest engine that ran and sounds right; the processor when nothing else did. */
export function pickBackend(trials: readonly Trial[]): SpeedChoice {
  const usable = trials.filter((t) => t.ok && t.rtf > 0 && Number.isFinite(t.rtf));
  const best = usable.reduce<Trial | null>((a, t) => (!a || t.rtf > a.rtf ? t : a), null);
  const wasm = trials.find((t) => t.backend === "wasm");
  const chosen = best ?? wasm ?? { backend: "wasm" as const, rtf: 0, ok: false };
  return { backend: chosen.backend, rtf: chosen.rtf, trials: [...trials], cached: false };
}

/** A sentence's speech, summarised to compare two engines. */
export interface SpeechShape {
  seconds: number;
  /** Root mean square of the samples. */
  rms: number;
  /** Every sample is a finite number. */
  finite: boolean;
}

export function shapeOf(samples: Float32Array, sampleRate: number): SpeechShape {
  let sum = 0;
  let finite = true;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (!Number.isFinite(s)) finite = false;
    else sum += s * s;
  }
  return { seconds: sampleRate > 0 ? samples.length / sampleRate : 0, rms: samples.length ? Math.sqrt(sum / samples.length) : 0, finite };
}

/**
 * The graphics chip's speech matches the processor's: the same sentence, in
 * the same voice, comes out within 10% of the processor's length and with a
 * loudness within a factor of two. The model decides each sound's length
 * itself, so an engine that computes it wrongly (a quantized operator it does
 * not support) says the sentence at a different length, or as noise or silence.
 */
export function soundsRight(candidate: SpeechShape, reference: SpeechShape): boolean {
  if (!candidate.finite || !(candidate.seconds > 0) || !(reference.seconds > 0) || !(reference.rms > 0)) return false;
  if (Math.abs(candidate.seconds - reference.seconds) > 0.1 * reference.seconds) return false;
  const ratio = candidate.rms / reference.rms;
  return ratio > 0.5 && ratio < 2;
}
