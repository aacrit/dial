// Downloads the graphics chip's copy of the voice (speed/gpu-model.ts) off
// the page's thread and off the render worker's (which is busy making
// lines), at the listener's choice. It posts its progress, its own request
// record for the Seal's log (worker-requests.ts), and whether the model is
// now kept on this device. Nothing is sent anywhere.

import type { RawEntry } from "../request-log";
import { watchWorkerRequests } from "../worker-requests";
import { downloadGpuModel } from "./gpu-model";

export type FromGpuDownload =
  | { type: "progress"; loaded: number; total: number }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "requests"; entries: RawEntry[] };

const ctx = self as unknown as { postMessage(message: FromGpuDownload): void; onmessage: ((event: MessageEvent<unknown>) => void) | null };

const flushRequests = watchWorkerRequests((entries) => ctx.postMessage({ type: "requests", entries }));

ctx.onmessage = () => {
  let shown = -1;
  downloadGpuModel((loaded, total) => {
    // Once per megabyte, not per chunk.
    const mb = Math.floor(loaded / 1_000_000);
    if (mb === shown && loaded < total) return;
    shown = mb;
    ctx.postMessage({ type: "progress", loaded, total });
  })
    .then(() => {
      flushRequests();
      ctx.postMessage({ type: "done" });
    })
    .catch((err: unknown) => {
      flushRequests();
      ctx.postMessage({ type: "error", message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    });
};
