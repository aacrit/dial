// Inside a voice worker or the offline helper (the service worker): its own
// Resource Timing entries (the voice model, its runtime, the voice files, the
// shell the helper keeps), posted back to the page so the Seal's log shows
// them too. A worker has its own record, which the page cannot read. Only
// the address, start time and sizes are posted.

import type { RawEntry } from "./request-log";

/** The message the offline helper posts its entries in, and the one a page sends to ask for them. */
export const REQUESTS_MESSAGE = "dial-requests";
export const REQUESTS_ASK = "dial-requests-ask";

/** Resource Timing entries in the shape the log records (request-log.ts RawEntry). */
export function toRawEntries(list: PerformanceEntryList): RawEntry[] {
  return (list as PerformanceResourceTiming[]).map((e) => ({
    url: e.name,
    t: performance.timeOrigin + e.startTime,
    transferSize: e.transferSize,
    encodedBodySize: e.encodedBodySize,
    workerStart: e.workerStart,
  }));
}

/** Watches this worker's requests; returns a flush that posts any not yet delivered. */
export function watchWorkerRequests(post: (entries: RawEntry[]) => void): () => void {
  if (typeof PerformanceObserver !== "function") return () => {};
  const send = (list: PerformanceEntryList) => {
    if (list.length) post(toRawEntries(list));
  };
  let observer: PerformanceObserver;
  try {
    observer = new PerformanceObserver((list) => send(list.getEntries()));
    observer.observe({ type: "resource", buffered: true });
  } catch {
    return () => {};
  }
  return () => send(observer.takeRecords());
}
