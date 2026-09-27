// The graphics chip's copy of the voice (T7): Kokoro-82M at full precision,
// staged and pinned by scripts/fetch-voice.mjs in its own parts
// (manifest.gpu). It is downloaded only when the listener chooses to test
// the graphics chip, after its size is shown, from this origin only (Law 1),
// checked against its pin and kept in the voice's own cache with that pin
// beside it (voice-files.ts heldGpuModel), where the render worker opens it.
// A worker of its own downloads it (gpu-download.worker.ts), because the
// render worker is busy making lines: the processor keeps making the work
// while it arrives.

import { GPU_PIN_HEADER, gpuModelKey, stitchModel } from "../voice-files";
import { voiceCacheName, type SizedManifest, type VoicePins } from "../voice-cache";

export interface GpuManifest extends VoicePins, SizedManifest {
  sha256: string;
  gpu?: { model: string; sha256: string; parts: string[]; bytes: number };
}

/** Downloads, checks and keeps the graphics chip's model. Throws if it cannot be fetched, does not match its pin, or cannot be kept (no room). */
export async function downloadGpuModel(onProgress: (loaded: number, total: number) => void): Promise<void> {
  const res = await fetch("/voice/manifest.json");
  if (!res.ok) throw new Error(`voice manifest: ${res.status}`);
  const m = (await res.json()) as GpuManifest;
  const gpu = m.gpu;
  if (!gpu) throw new Error("voice: no model for the graphics chip");
  let loaded = 0;
  onProgress(0, gpu.bytes);
  // stitchModel checks the whole against its pin before it answers.
  const stitched = await stitchModel({ repo: m.repo, parts: gpu.parts, sizes: m.sizes, sha256: gpu.sha256 }, (bytes) => {
    loaded += bytes;
    onProgress(Math.min(loaded, gpu.bytes), gpu.bytes);
  });
  const kept = new Response(await stitched.blob(), { headers: { "content-type": "application/octet-stream", [GPU_PIN_HEADER]: gpu.sha256 } });
  await (await caches.open(voiceCacheName(m))).put(gpuModelKey({ repo: m.repo, gpu }), kept);
}
