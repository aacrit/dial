// The Seal's request log, as pure functions: which requests this tab made,
// which of them sent something, whether every one went to this origin, and
// the log's HTML. No DOM, no storage, no clock: request-recorder.ts feeds
// these from the browser's own record (Resource Timing), and seal.ts shows
// them. Every value that reaches HTML is escaped (render.ts esc), because
// a path comes from the network and the log comes back from storage.

import { esc } from "./render";
import { VOICE_NAMES, type VoiceId } from "./engine/cast";

/** The paths that send something (privacy-allowlist.json "sends"; tests/seal.test.ts keeps them equal). */
export const SEND_PATHS = ["/e", "/feedback"] as const;

export type Direction = "fetched" | "sent" | "blocked";

export type HelperBy = "helper" | "shared";

/**
 * One request, as the log keeps it: when, where, which way and how big.
 * Never text or audio: a path, a size and, for a count, its event name.
 */
export interface RequestRecord {
  /** Milliseconds since the epoch, when the request started. */
  t: number;
  /** The path and query on this origin, or the whole address when it is another origin's. */
  path: string;
  /** Whether the request went to this origin. */
  own: boolean;
  dir: Direction;
  /** Fetched: the body's bytes. Sent: the request body's bytes. Null when the browser does not say. */
  bytes: number | null;
  /**
   * Answered without the network: "cache" is the browser's HTTP cache,
   * "helper" is Dial's offline helper (the service worker; its own request,
   * if it made one, is a row of its own).
   */
  served?: "cache" | "helper";
  /**
   * A request Dial's offline helper made: "helper" for this tab (a page's
   * request passed on), "shared" for itself (the page files it keeps for
   * every Dial tab), which every tab's log lists, marked so.
   */
  by?: HelperBy;
  /** A count's event name ("page_view"), for a sent /e row. */
  event?: string;
  /** A send that never reached the server (the network failed): not delivered. */
  failed?: true;
}

/** The keys a record may carry, and nothing else (tests/privacy-page.test.ts reads this list). */
export const RECORD_KEYS = ["t", "path", "own", "dir", "bytes", "served", "by", "event", "failed"] as const;

/** What the browser's record gives for one request: its address, its start and its sizes. */
export interface RawEntry {
  url: string;
  /** Milliseconds since the epoch (timeOrigin + startTime). */
  t: number;
  transferSize: number;
  encodedBodySize: number;
  /** When a service worker started handling it; above 0 means Dial's offline helper answered. */
  workerStart?: number;
}

/** Where a request went, or null when it was not a network request (data:, blob:, about:). */
export function classify(url: string, origin: string): { path: string; own: boolean; dir: "fetched" | "sent" } | null {
  let u: URL;
  try {
    // Absolute addresses only: the browser records every request that way, and
    // a CSP report names "inline" or "eval" for things that were not requests.
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const own = u.origin === origin;
  if (!own) return { path: `${u.origin}${u.pathname}${u.search}`, own, dir: "fetched" };
  const dir = (SEND_PATHS as readonly string[]).includes(u.pathname) ? "sent" : "fetched";
  return { path: `${u.pathname}${u.search}`, own, dir };
}

/** A Resource Timing entry as a record. A send is recorded by its sender instead (see `sentRecord` and `confirmSend`). */
export function fromEntry(e: RawEntry, origin: string, by?: HelperBy): RequestRecord | null {
  const c = classify(e.url, origin);
  if (!c) return null;
  const rec: RequestRecord = { t: Math.round(e.t), path: c.path, own: c.own, dir: c.dir, bytes: null };
  if (c.dir === "fetched") {
    // A size of 0 means the browser did not say: another origin that does not
    // allow timing, or a copy served from memory. Then the size is not known.
    rec.bytes = e.encodedBodySize > 0 ? e.encodedBodySize : null;
    if (c.own && (e.workerStart ?? 0) > 0) rec.served = "helper";
    else if (c.own && e.transferSize === 0) rec.served = "cache";
  }
  if (by) rec.by = by;
  return rec;
}

/** A request the browser blocked under the page's rules (a securitypolicyviolation), or null when it was not a request. */
export function blockedRecord(blockedURI: string, t: number, origin: string): RequestRecord | null {
  const c = classify(blockedURI, origin);
  if (!c) return null;
  return { t: Math.round(t), path: c.path, own: c.own, dir: "blocked", bytes: null };
}

/**
 * A send, recorded by its sender at the moment it posts: the path, the
 * body's bytes and, for a count, the event. It is written to the log then,
 * so it is listed even if the browser's record never mentions it.
 */
export function sentRecord(path: string, bytes: number, t: number, event?: string): RequestRecord {
  const rec: RequestRecord = { t: Math.round(t), path, own: true, dir: "sent", bytes };
  if (event) rec.event = event;
  return rec;
}

/**
 * A sent entry from the browser's record only confirms a send its sender
 * already recorded: it takes the oldest unconfirmed one for the same path
 * off `pending` and adds nothing (null). A send nobody recorded is listed
 * as it is, with its size not known. Other entries pass through.
 */
export function confirmSend(rec: RequestRecord, pending: string[]): RequestRecord | null {
  if (rec.dir !== "sent" || !rec.own) return rec;
  const i = pending.indexOf(rec.path.split("?")[0]!);
  if (i < 0) return rec;
  pending.splice(i, 1);
  return null;
}

const DIRECTIONS: readonly Direction[] = ["fetched", "sent", "blocked"];
const EVENT_NAME = /^[a-z_]{1,40}$/;

/** A record read back from storage, checked field by field; anything else is dropped. */
export function toRecord(x: unknown): RequestRecord | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  if (typeof r.t !== "number" || !Number.isFinite(r.t)) return null;
  if (typeof r.path !== "string" || r.path.length === 0 || r.path.length > 2048) return null;
  if (typeof r.own !== "boolean") return null;
  if (typeof r.dir !== "string" || !DIRECTIONS.includes(r.dir as Direction)) return null;
  if (r.bytes !== null && (typeof r.bytes !== "number" || !Number.isFinite(r.bytes) || r.bytes < 0)) return null;
  const rec: RequestRecord = { t: r.t, path: r.path, own: r.own, dir: r.dir as Direction, bytes: r.bytes as number | null };
  if (r.served === "cache" || r.served === "helper") rec.served = r.served;
  if (r.by === "helper" || r.by === "shared") rec.by = r.by;
  if (r.failed === true && rec.dir === "sent") rec.failed = true;
  if (typeof r.event === "string" && EVENT_NAME.test(r.event)) rec.event = r.event;
  return rec;
}

/** The stored log: the records, and how many old ones were let go to stay under the cap. */
export interface StoredLog {
  records: RequestRecord[];
  dropped: number;
}

/** Marks the send recorded at `t` for `path` as not delivered. */
export function markFailed(log: StoredLog, t: number, path: string): StoredLog {
  const i = log.records.findIndex((r) => r.dir === "sent" && r.t === Math.round(t) && r.path === path && !r.failed);
  if (i < 0) return log;
  const records = log.records.slice();
  records[i] = { ...records[i]!, failed: true };
  return { records, dropped: log.dropped };
}

const helperKey = (r: RequestRecord) => `${Math.round(r.t)}|${r.path}|${r.by}|${r.dir}`;

/**
 * The offline helper's rows not already in the log, by (time, path, by,
 * direction): the helper posts to every open page and answers each page
 * that asks, so the same entry can reach a tab more than once. Other rows
 * pass through.
 */
export function newHelperRows(log: StoredLog, add: readonly RequestRecord[]): RequestRecord[] {
  const held = new Set(log.records.filter((r) => r.by).map(helperKey));
  const out: RequestRecord[] = [];
  for (const r of add) {
    if (r.by) {
      const k = helperKey(r);
      if (held.has(k)) continue;
      held.add(k);
    }
    out.push(r);
  }
  return out;
}

/** The newest helper row of one kind in the log, or 0: a page asks the helper only for entries after it, own and shared apart. */
export function newestHelperRow(log: StoredLog, by: HelperBy): number {
  return log.records.reduce((m, r) => (r.by === by ? Math.max(m, Math.round(r.t)) : m), 0);
}

/** At most this many records are kept; the oldest go first, and the Seal says how many. */
export const LOG_CAP = 1500;

/** Reads the stored log; anything unreadable is an empty log. */
export function parseLog(raw: string | null): StoredLog {
  if (!raw) return { records: [], dropped: 0 };
  try {
    const v = JSON.parse(raw) as { records?: unknown; dropped?: unknown };
    const records = Array.isArray(v.records) ? v.records.map(toRecord).filter((r): r is RequestRecord => r !== null) : [];
    const dropped = typeof v.dropped === "number" && Number.isFinite(v.dropped) && v.dropped > 0 ? Math.floor(v.dropped) : 0;
    return { records, dropped };
  } catch {
    return { records: [], dropped: 0 };
  }
}

/** Adds records, newest last, and keeps at most `cap`. */
export function appendLog(log: StoredLog, add: readonly RequestRecord[], cap = LOG_CAP): StoredLog {
  const all = [...log.records, ...add].sort((a, b) => a.t - b.t);
  const over = Math.max(0, all.length - cap);
  return { records: all.slice(over), dropped: log.dropped + over };
}

/** Only the record's own keys, so nothing else is ever written to storage. */
export function serializeLog(log: StoredLog): string {
  const records = log.records.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of RECORD_KEYS) if (r[k] !== undefined) out[k] = r[k];
    return out;
  });
  return JSON.stringify({ records, dropped: log.dropped });
}

export interface LogSummary {
  /** Sent counts and their bytes. */
  counts: number;
  /** Sent feedback messages. */
  feedback: number;
  sentBytes: number;
  /** Delivered sends whose size is not known (sent by code that did not record them). */
  sentUnknown: number;
  /** Sends that never reached the server; not in counts, feedback or sentBytes. */
  failed: number;
  fetched: number;
  /** Bytes that crossed the network; a file from this device's cache adds none. */
  fetchedBytes: number;
  /** Fetched files answered by the browser's HTTP cache. */
  cached: number;
  /** Fetched files answered by Dial's offline helper. */
  helper: number;
  /** Files the offline helper fetched for itself, shared by every Dial tab: not in fetched. */
  shared: number;
  sharedBytes: number;
  blocked: number;
  /** Requests (fetched or sent) that went to another origin. Under the CSP this stays 0. */
  foreign: number;
  /** The first request's time, or null for an empty log. */
  since: number | null;
  /** The last send's time, or null. */
  lastSent: number | null;
}

export function summarize(records: readonly RequestRecord[]): LogSummary {
  const s: LogSummary = { counts: 0, feedback: 0, sentBytes: 0, sentUnknown: 0, failed: 0, fetched: 0, fetchedBytes: 0, cached: 0, helper: 0, shared: 0, sharedBytes: 0, blocked: 0, foreign: 0, since: null, lastSent: null };
  for (const r of records) {
    s.since = s.since === null ? r.t : Math.min(s.since, r.t);
    if (r.dir === "blocked") {
      s.blocked++;
      continue;
    }
    if (!r.own) s.foreign++;
    if (r.dir === "sent") {
      if (r.failed) {
        s.failed++;
        continue;
      }
      if (r.path.split("?")[0] === "/feedback") s.feedback++;
      else s.counts++;
      if (r.bytes === null) s.sentUnknown++;
      else s.sentBytes += r.bytes;
      s.lastSent = s.lastSent === null ? r.t : Math.max(s.lastSent, r.t);
    } else if (r.by === "shared") {
      s.shared++;
      s.sharedBytes += r.served ? 0 : (r.bytes ?? 0);
    } else {
      s.fetched++;
      if (r.served === "cache") s.cached++;
      else if (r.served === "helper") s.helper++;
      else s.fetchedBytes += r.bytes ?? 0;
    }
  }
  return s;
}

/** Sealed: every request that was made went to this origin. Blocked ones never left, so they do not open the eye. */
export function isSealed(records: readonly RequestRecord[]): boolean {
  return records.every((r) => r.own || r.dir === "blocked");
}

/** "3.1 kB", "114.6 MB", "27 B", decimal units. */
export function sizeLabel(bytes: number | null): string {
  if (bytes === null) return "not known";
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${bytes} B`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 21:04:07, in this device's local time. */
export function clock(t: number, withSeconds = true): string {
  const d = new Date(t);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${hm}:${pad(d.getSeconds())}` : hm;
}

const MODEL_PART = /^\/voice\/models\/.+\/onnx\/[^/]*\.part(\d+)$/;

/** What a request was, in plain words, from its path alone. */
export function whatItWas(r: Pick<RequestRecord, "path" | "own" | "dir" | "event">): string {
  if (r.dir === "blocked") return "Blocked by the browser before it left";
  if (!r.own) return "A request to another address";
  const p = r.path.split("?")[0]!;
  if (p === "/e") return r.event ? `Count: ${r.event}` : "Count";
  if (p === "/feedback") return "Your feedback message";
  if (p === "/" || p.endsWith(".html") || /^\/(seal|privacy)\/?$/.test(p)) return "The page";
  if (p.startsWith("/works/")) return "A work's text";
  if (p === "/voice/manifest.json") return "Voice checksums";
  const part = MODEL_PART.exec(p);
  if (part) return `Voice model, part ${Number(part[1]) + 1}`;
  if (p.startsWith("/voice/models/")) return "Voice model settings";
  const voice = /^\/voice\/voices\/([a-z_]+)\.bin$/.exec(p)?.[1];
  if (voice) return Object.hasOwn(VOICE_NAMES, voice) ? `Voice: ${VOICE_NAMES[voice as VoiceId]}` : "A voice";
  if (p.startsWith("/ort/")) return "Voice runtime";
  if (p.endsWith(".woff2") || p.endsWith(".woff")) return "Typeface";
  if (p.endsWith(".css")) return "Styles";
  if (p.endsWith(".js") || p.endsWith(".mjs")) return "App code";
  if (p === "/healthz") return "Health check";
  return "A file from this site";
}

const GLYPH = {
  fetched: `<svg class="glyph" role="img" aria-label="Fetched"><use href="#g-down"/></svg>`,
  sent: `<svg class="glyph" role="img" aria-label="Sent"><use href="#g-up"/></svg>`,
  blocked: `<svg class="glyph" role="img" aria-label="Blocked"><use href="#g-x"/></svg>`,
} as const;

const num = (s: string) => `<span data-numeral>${esc(s)}</span>`;

/** The log's rows, newest last. Every path and label is escaped. */
export function logRowsHtml(records: readonly RequestRecord[]): string {
  return records
    .map((r) => {
      const cls = [r.dir === "fetched" ? "" : r.dir, r.own || r.dir === "blocked" ? "" : "foreign", r.failed ? "failed" : ""].filter(Boolean).join(" ");
      const what = whatItWas(r);
      const size = r.dir === "blocked" ? "none" : sizeLabel(r.bytes);
      const note =
        r.served === "cache"
          ? "from this device's cache"
          : r.served === "helper"
            ? "from Dial's offline helper"
            : r.by === "helper"
              ? "requested by Dial's offline helper for this tab"
              : r.by === "shared"
                ? "made by the offline helper, which every Dial tab shares"
                : r.failed
                ? "not delivered"
                : "";
      const cached = note ? ` <span class="cached">${esc(note)}</span>` : "";
      return (
        `<tr${cls ? ` class="${cls}"` : ""}>` +
        `<td class="dir">${GLYPH[r.dir]}</td>` +
        `<td class="tm">${num(clock(r.t))}</td>` +
        `<td class="pa">${esc(r.path)}<span class="w">${esc(what)}${cached}</span></td>` +
        `<td class="wh">${esc(what)}${cached}</td>` +
        `<td class="sz">${size === "none" || size === "not known" ? esc(size) : num(size)}</td>` +
        `</tr>`
      );
    })
    .join("");
}

const plural = (n: number, one: string, many: string) => `${num(String(n))} ${n === 1 ? one : many}`;

/** The totals line: "Sent: 1 count, 27 B · Fetched: 15 files, 114.6 MB". */
export function totalsHtml(s: LogSummary): string {
  const sentParts: string[] = [];
  if (s.counts) sentParts.push(plural(s.counts, "count", "counts"));
  if (s.feedback) sentParts.push(plural(s.feedback, "feedback message", "feedback messages"));
  const failed = s.failed ? `; ${plural(s.failed, "more was", "more were")} not delivered` : "";
  const sent = (sentParts.length ? `${sentParts.join(" and ")}, ${num(sizeLabel(s.sentBytes))}${s.sentUnknown ? " and some not known" : ""}` : "nothing") + failed;
  const answered: string[] = [];
  if (s.cached) answered.push(`${num(String(s.cached))} from this device's cache`);
  if (s.helper) answered.push(`${num(String(s.helper))} from Dial's offline helper`);
  const served = answered.length ? `; ${answered.join(" and ")}` : "";
  const fetched = `${plural(s.fetched, "file", "files")}, ${num(sizeLabel(s.fetchedBytes))} over the network${served}`;
  const blocked = s.blocked ? ` &middot; Blocked: ${plural(s.blocked, "request", "requests")}` : "";
  const shared = s.shared ? ` &middot; Offline helper, shared by every tab: <b>${plural(s.shared, "file", "files")}, ${num(sizeLabel(s.sharedBytes))}</b>` : "";
  return `Sent: <b>${sent}</b> &middot; Fetched: <b>${fetched}</b>${shared}${blocked}`;
}

/** The counts switch as the Seal reads it. */
export type CountsState = "on" | "off";

/**
 * The Seal's headline and sentence, from the log and the counts switch.
 * `dropped`: old records let go to keep the log small; then the log no
 * longer starts when Dial was opened, and the sentence says only "Since".
 */
export function sealWords(s: LogSummary, sealed: boolean, counts: CountsState, host: string, dropped = 0): { headline: string; say: string } {
  const h = esc(host);
  if (!sealed) {
    return {
      headline: "Open",
      say: `This tab made ${plural(s.foreign, "request", "requests")} to another address. Dial's pages allow requests to ${h} only, so this should not be possible; the rows are marked in the log below.`,
    };
  }
  if (s.blocked) {
    return {
      headline: "Still sealed",
      say: `The browser blocked ${plural(s.blocked, "request", "requests")} to another site before ${s.blocked === 1 ? "it" : "they"} left. Dial loads nothing from other sites, so ${s.blocked === 1 ? "it" : "they"} came from code Dial did not ship, most likely a browser extension.`,
    };
  }
  const since = s.since === null ? "" : dropped > 0 ? `Since ${num(clock(s.since, false))}, ` : `Since you opened Dial at ${num(clock(s.since, false))}, `;
  const sentWhat: string[] = [];
  if (s.counts) sentWhat.push(`${plural(s.counts, "count", "counts")} with no identifier and no content`);
  if (s.feedback) sentWhat.push(`${plural(s.feedback, "feedback message", "feedback messages")} you wrote`);
  const bytes = s.sentUnknown ? "" : `: ${num(String(s.sentBytes))} bytes`;
  const failed = s.failed ? ` ${plural(s.failed, "more send was", "more sends were")} not delivered: the network failed before ${s.failed === 1 ? "it" : "they"} arrived.` : "";
  const fetched = `${plural(s.fetched, "file", "files")} from ${h}`;
  let say: string;
  if (sentWhat.length) {
    say = `${since}this tab has sent ${sentWhat.join(" and ")}${bytes}.${failed} Everything else was fetched: ${fetched}, and it stays on this device.`;
  } else {
    say = `${since}this tab has sent nothing.${failed} It has fetched ${fetched}, and it stays on this device.`;
  }
  say = say.charAt(0).toUpperCase() + say.slice(1);
  if (s.shared) say += ` Dial's offline helper, which every Dial tab shares, also fetched ${plural(s.shared, "file", "files")} of this site's own for itself.`;
  const before = s.counts ? " Counts sent before you turned them off are still listed below, because the log shows everything." : "";
  if (counts === "off") say = `Counts are off, so this tab sends none.${before} ${say}`;
  return { headline: "Sealed", say };
}

/** The log's footer: newest last, where requests went, and how many old ones were let go. */
export function footHtml(sealed: boolean, dropped: number): string {
  const where = sealed ? "Nothing has been sent to any other address." : "Marked rows went to another address.";
  const gone = dropped > 0 ? ` The oldest ${plural(dropped, "request is", "requests are")} no longer listed, to keep the log small.` : "";
  return `Newest last. ${where}${gone}`;
}
