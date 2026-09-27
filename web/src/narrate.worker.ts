// The render runs here, off the page's thread: each cue is spoken in order,
// in the voice the cast gave it (engine/cast.ts), and its samples are posted
// back. Messages carry only cue text in and
// audio out, plus this worker's own request record (address, time, size)
// for the Seal's log; this worker has no other channel.
//
// The loop itself, the engine choice and the speed test are
// speed/render-loop.ts (driven by tests with fake engines); this file hands
// it the real voice loader, engines and channel.

import type { KokoroTTS } from "kokoro-js";
import { dropGpuModel, gpuModelHeld, loadVoice, openVoice } from "./voice";
import { RenderLoop, type FromWorker, type Speaker, type ToWorker } from "./speed/render-loop";
import { watchWorkerRequests } from "./worker-requests";

export type { FromWorker, ToWorker };

const ctx = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

const flushRequests = watchWorkerRequests((entries) => ctx.postMessage({ type: "requests", entries }));

/** Whether this browser offers WebGPU to a worker, with an adapter behind it (a plain request: which adapter is the browser's choice). */
async function hasGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

const asSpeaker = (tts: KokoroTTS) => tts as unknown as Speaker;

const loop = new RenderLoop({
  loadVoice: async (voices, onProgress, openCpu) => {
    const { tts, manifest, kept } = await loadVoice(voices, onProgress, openCpu);
    return { tts: tts && asSpeaker(tts), manifest, kept };
  },
  openVoice: async (manifest, backend) => asSpeaker(await openVoice(manifest, backend)),
  gpuModelHeld,
  dropGpuModel,
  hasGpu,
  post: (message, transfer) => ctx.postMessage(message, transfer),
  flushRequests,
  turn: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
});

ctx.onmessage = (event) => loop.onMessage(event.data);
