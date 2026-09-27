// The graphics chip's copy of the voice (T7): Kokoro-82M at full precision,
// staged and pinned by scripts/fetch-voice.mjs in its own parts
// (manifest.gpu, each part pinned too). It is offered only on a device that
// can hold it (gpuOfferAllowed: 8 GB of memory or more as the browser reports
// it, and never a phone) and downloaded only when the listener chooses to
// test the graphics chip, after its size is shown, from this origin only
// (Law 1). The parts are streamed straight into Cache Storage one at a time,
// each checked against its pin, so the 326 MB model is never held in memory;
// the kept copy carries the whole's pin (voice-files.ts heldGpuModel), and
// the render worker opens it from there. A worker of its own downloads it
// (gpu-download.worker.ts), because the render worker is busy making lines.

import { GPU_PIN_HEADER, gpuModelKey, sha256Hex } from "../voice-files";
import { voiceCacheName, type SizedManifest, type VoicePins } from "../voice-cache";

export interface GpuManifest extends VoicePins, SizedManifest {
  sha256: string;
  gpu?: { model: string; sha256: string; parts: string[]; partSha256: string[]; bytes: number };
}

/** What the browser says about the device, for the offer (every field may be missing). */
export interface DeviceHints {
  deviceMemory?: number;
  userAgentData?: { mobile?: boolean };
}

/** The free space needed before the download starts: the model plus a tenth. */
export const ROOM_MARGIN = 1.1;

/**
 * Whether to offer the graphics chip's 326 MB model on this device: only
 * where the browser reports 8 GB of memory or more, and never on a phone
 * (the browser says it is mobile, or, where it does not say, a coarse
 * pointer on a small screen). A browser that reports no memory is not offered it.
 */
export function gpuOfferAllowed(nav: DeviceHints, coarseSmallScreen: boolean): boolean {
  if (nav.userAgentData?.mobile === true) return false;
  if (nav.userAgentData?.mobile === undefined && coarseSmallScreen) return false;
  return typeof nav.deviceMemory === "number" && nav.deviceMemory >= 8;
}

/** Whether the storage estimate leaves room for `bytes` plus the margin; no estimate means the write itself will tell. */
export function roomFor(bytes: number, estimate: { quota?: number; usage?: number } | null): boolean {
  if (!estimate || typeof estimate.quota !== "number") return true;
  return estimate.quota - (estimate.usage ?? 0) >= bytes * ROOM_MARGIN;
}

/** No room on this device for the model: the listener is told to free some space. */
export class NoRoomError extends Error {
  override name = "NoRoomError";
}

export interface DownloadDeps {
  fetch: typeof fetch;
  open: (name: string) => Promise<Pick<Cache, "put" | "delete">>;
  estimate: () => Promise<{ quota?: number; usage?: number } | null>;
  sha256: (buf: ArrayBuffer) => Promise<string>;
}

const browserDeps = (): DownloadDeps => ({
  fetch: globalThis.fetch.bind(globalThis),
  open: (name) => caches.open(name),
  estimate: async () => (navigator.storage?.estimate ? navigator.storage.estimate() : null),
  sha256: sha256Hex,
});

/**
 * Downloads, checks and keeps the graphics chip's model. Throws NoRoomError
 * when the device has no room for it, and an error when a part cannot be
 * fetched or does not match its pin; then nothing is kept.
 */
export async function downloadGpuModel(onProgress: (loaded: number, total: number) => void, deps: DownloadDeps = browserDeps()): Promise<void> {
  const res = await deps.fetch("/voice/manifest.json");
  if (!res.ok) throw new Error(`voice manifest: ${res.status}`);
  const m = (await res.json()) as GpuManifest;
  const gpu = m.gpu;
  if (!gpu || gpu.partSha256?.length !== gpu.parts.length) throw new Error("voice: no pinned model for the graphics chip");
  if (!roomFor(gpu.bytes, await deps.estimate().catch(() => null))) throw new NoRoomError("there is no room on this device for the graphics chip's voice");
  const cache = await deps.open(voiceCacheName(m));
  const key = gpuModelKey({ repo: m.repo, gpu });
  // A copy under an older pin (or a half-kept one) goes first.
  await cache.delete(key);
  let loaded = 0;
  let next = 0;
  onProgress(0, gpu.bytes);
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (next >= gpu.parts.length) return c.close();
      const i = next++;
      const part = await deps.fetch(`/voice/models/${m.repo}/onnx/${gpu.parts[i]}`);
      if (!part.ok) throw new Error(`voice part ${gpu.parts[i]}: ${part.status}`);
      const buf = await part.arrayBuffer();
      if ((await deps.sha256(buf)) !== gpu.partSha256[i]) throw new Error("voice: the graphics chip's model did not match its pin");
      loaded += buf.byteLength;
      onProgress(Math.min(loaded, gpu.bytes), gpu.bytes);
      c.enqueue(new Uint8Array(buf));
    },
  });
  try {
    await cache.put(key, new Response(body, { headers: { "content-type": "application/octet-stream", "content-length": String(gpu.bytes), [GPU_PIN_HEADER]: gpu.sha256 } }));
  } catch (err) {
    await cache.delete(key).catch(() => undefined);
    if (err instanceof Error && /Quota/i.test(err.name + err.message)) throw new NoRoomError(err.message);
    throw err;
  }
  if (loaded !== gpu.bytes) {
    await cache.delete(key);
    throw new Error("voice: the graphics chip's model did not match its pin");
  }
}
