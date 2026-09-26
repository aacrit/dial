// The render runs here, off the page's thread: the voice speaks each cue in
// order and posts its samples back. Messages carry only cue text in and
// audio out; this worker has no other channel.

import { loadVoice } from "./voice";
import type { Cue } from "./engine/segment";

export type ToWorker = { type: "render"; cues: Cue[] };
export type FromWorker =
  | { type: "loading"; loaded: number; total: number; fromDevice: boolean }
  | { type: "ready" }
  | { type: "cue"; index: number; audio: Float32Array<ArrayBuffer>; sampleRate: number }
  | { type: "done" }
  | { type: "error"; message: string };

const ctx = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

ctx.onmessage = async (event) => {
  if (event.data.type !== "render") return;
  try {
    const { tts, manifest } = await loadVoice((loaded, total, fromDevice) => ctx.postMessage({ type: "loading", loaded, total, fromDevice }));
    ctx.postMessage({ type: "ready" });
    const cues = event.data.cues;
    for (let i = 0; i < cues.length; i++) {
      const raw = await tts.generate(cues[i]!.spoken, { voice: manifest.narrator as "bm_george" });
      const audio = raw.audio as Float32Array<ArrayBuffer>;
      ctx.postMessage({ type: "cue", index: i, audio, sampleRate: raw.sampling_rate }, [audio.buffer]);
    }
    ctx.postMessage({ type: "done" });
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
