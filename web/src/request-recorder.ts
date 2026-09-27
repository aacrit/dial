// Records this tab's requests for the Seal, from the browser's own record.
// Each Dial page (the radio at /, the Seal at /seal) runs recordRequests():
// a PerformanceObserver on Resource Timing (buffered, so it also sees what
// loaded before the script ran) and on the page's navigation, plus the
// browser's securitypolicyviolation events for anything the CSP blocked.
// The voice workers post their own Resource Timing entries back
// (worker-requests.ts), and they are recorded here the same way; so does
// Dial's offline helper (the service worker, web/src/sw.ts), whose rows are
// marked as its own requests.
//
// The log is kept in sessionStorage under LOG_KEY, so the Seal can show
// what the radio fetched earlier in the same tab. It holds a path, a size, a
// time and, for a count, the event name (request-log.ts RECORD_KEYS): never
// text or audio. It is erased when the tab closes, and it is never sent
// (web/privacy.html says so; tests/privacy-page.test.ts pairs the two).
// Where the browser blocks session storage, the log lives in this page's
// memory only.

import { appendLog, blockedRecord, confirmSend, fromEntry, markFailed, newHelperRows, newestHelperRow, parseLog, sentRecord, serializeLog, type HelperBy, type RawEntry, type RequestRecord, type StoredLog } from "./request-log";
import { REQUESTS_ASK, REQUESTS_MESSAGE, toRawEntries } from "./worker-requests";

export const LOG_KEY = "dial.requests";

let memory: StoredLog = { records: [], dropped: 0 };
/** Set once a write fails: from then on this page's memory is the log. */
let memoryOnly = false;
/** Paths of sends recorded here that the browser's record has not confirmed yet. */
const pending: string[] = [];
const seen = new Set<string>();
const listeners = new Set<(log: StoredLog) => void>();

function tabStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The log so far: this tab's, or this page's where session storage is blocked. */
export function readLog(): StoredLog {
  const store = tabStore();
  if (!store || memoryOnly) return memory;
  try {
    return parseLog(store.getItem(LOG_KEY));
  } catch {
    return memory;
  }
}

function writeLog(next: StoredLog): void {
  memory = next;
  try {
    if (!memoryOnly) tabStore()?.setItem(LOG_KEY, serializeLog(next));
  } catch {
    // Storage full or blocked: this page keeps the log in memory.
    memoryOnly = true;
  }
  for (const fn of listeners) fn(next);
}

function addRecords(add: RequestRecord[]): void {
  if (add.length === 0) return;
  const log = readLog();
  // The helper's rows can arrive more than once (posted live, and again when a page asks): each is kept once.
  const fresh = newHelperRows(log, add);
  if (fresh.length) writeLog(appendLog(log, fresh));
}

/** Which send a sender recorded, so it can say later that it was not delivered. */
export interface SendToken {
  t: number;
  path: string;
}

/**
 * Called by a sender just before it posts: the sent row is written to the
 * log at once, with the body's real size and, for a count, its name. The
 * browser's record of the request later only confirms it.
 */
export function noteSend(path: string, bytes: number, event?: string): SendToken {
  const rec = sentRecord(path, bytes, Date.now(), event);
  pending.push(path);
  addRecords([rec]);
  return { t: rec.t, path };
}

/** The send never reached the server (the network failed): its row says "not delivered". */
export function noteSendFailed(token: SendToken): void {
  writeLog(markFailed(readLog(), token.t, token.path));
}

/** Records entries from the browser's record, on this page or posted by a worker; `by` marks the offline helper's own. */
export function recordEntries(entries: readonly RawEntry[], by?: HelperBy): void {
  const origin = location.origin;
  const out: RequestRecord[] = [];
  for (const e of entries) {
    // The browser can hand the same entry over twice (the navigation entry
    // does): each one is recorded once.
    const key = `${e.t}|${e.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = fromEntry(e, origin, by);
    const kept = rec && confirmSend(rec, pending);
    if (kept) out.push(kept);
  }
  addRecords(out);
}

let started = false;

/** Starts recording this page's requests. `onChange` hears every addition. */
export function recordRequests(onChange?: (log: StoredLog) => void): void {
  if (onChange) listeners.add(onChange);
  if (started) return;
  started = true;
  if (typeof PerformanceObserver === "function") {
    for (const type of ["navigation", "resource"]) {
      try {
        new PerformanceObserver((list) => recordEntries(toRawEntries(list.getEntries()))).observe({ type, buffered: true });
      } catch {
        // An old browser without this entry type: nothing to record from it.
      }
    }
  }
  // The offline helper's own requests: it posts them as it makes them, and
  // answers this page's ask with what it has recorded since it started.
  const helper = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  if (helper) {
    helper.addEventListener("message", (e: MessageEvent) => {
      const data = e.data as { type?: string; entries?: unknown; shared?: unknown } | null;
      if (data?.type === REQUESTS_MESSAGE && Array.isArray(data.entries)) recordEntries(data.entries.filter(isRawEntry), data.shared === true ? "shared" : "helper");
    });
    helper.startMessages();
    void helper.ready.then((reg) => reg.active?.postMessage({ type: REQUESTS_ASK, after: newestHelperRow(readLog()) }));
  }
  document.addEventListener("securitypolicyviolation", (e) => {
    const rec = blockedRecord(e.blockedURI, performance.timeOrigin + e.timeStamp, location.origin);
    if (rec) addRecords([rec]);
  });
}

/** An entry posted by the helper, checked before it is recorded. */
function isRawEntry(x: unknown): x is RawEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return typeof e.url === "string" && typeof e.t === "number" && typeof e.transferSize === "number" && typeof e.encodedBodySize === "number";
}
