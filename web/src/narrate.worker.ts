// The render runs here, off the page's thread: each cue is spoken in order,
// in the voice the cast gave it (engine/cast.ts), and its samples are posted
// back. Messages carry only cue text in and
// audio out; this worker has no other channel.

import { loadVoice } from "./voice";
import type { VoiceId } from "./engine/cast";
import type { Cue } from "./engine/segment";

/** voices[i] is cue i's cast voice. */
export type ToWorker = { type: "render"; cues: Cue[]; voices: VoiceId[] };
export type FromWorker =
  | { type: "loading"; loaded: number; total: number; fromDevice: boolean }
  | { type: "ready"; kept: boolean }
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
    const { tts, manifest, kept } = await loadVoice((loaded, total, fromDevice) => ctx.postMessage({ type: "loading", loaded, total, fromDevice }));
    ctx.postMessage({ type: "ready", kept });
    const { cues, voices } = event.data;
    for (let i = 0; i < cues.length; i++) {
      // Only a voice the manifest pins, and so the loader has checked, is ever used.
      const voice = voices[i];
      if (!voice || !Object.hasOwn(manifest.voices, voice)) throw new Error(`voice: no pinned voice for line ${i + 1}`);
      const raw = await tts.generate(cues[i]!.spoken, { voice });
      const audio = raw.audio as Float32Array<ArrayBuffer>;
      ctx.postMessage({ type: "cue", index: i, audio, sampleRate: raw.sampling_rate }, [audio.buffer]);
    }
    ctx.postMessage({ type: "done" });
  } catch (err) {
    ctx.postMessage({ type: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
};
