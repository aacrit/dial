// T6, and T8's Seal widget: the Seal was a page at /seal and is now a
// widget on the radio's work panel (design/spec.md 00). The request log's
// classification (sent, fetched, blocked; this origin or not) as pure
// functions, the widget's words in every state, the counts switch that stops
// every sendEvent, the speed test engine's words and its no-send path (its
// gauge is T7's), and the escaping of everything the log renders.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  SEND_PATHS,
  appendLog,
  blockedRecord,
  classify,
  fromEntry,
  isSealed,
  logRowsHtml,
  confirmSend,
  countLineHtml,
  countsToday,
  footHtml,
  requestsIntroHtml,
  sealLineHtml,
  markFailed,
  newHelperRows,
  newestHelperRow,
  parseLog,
  sealWords,
  sentRecord,
  serializeLog,
  sizeLabel,
  summarize,
  toRecord,
  totalsHtml,
  whatItWas,
  type RequestRecord,
} from "../web/src/request-log";
import { COUNTS_KEY, STORAGE_REFUSED, canKeepSetting, countsOn, sendEvent, setCounts, type SendDeps, type SettingStore } from "../web/src/telemetry";
import { answerFor, claim, groupByClient, ownerOf, prune, remember, settle, HELPER_MEMORY, SETTLED_GRACE_MS, UNSETTLED_MAX_MS, type HelperEntry, type PendingFetch } from "../web/src/offline/attribution";
import { PLANNING_MARGIN, benchNeedLine, benchStopLine, cpuDetailsHtml, plannedSpeed, reportsHtml, speedLabel, speedOf, verdictHtml } from "../web/src/bench";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const ORIGIN = "https://dial.voidvision.org";
const XSS = `"><img src=x onerror=alert(1)>`;

const entry = (url: string, over: Partial<{ t: number; transferSize: number; encodedBodySize: number }> = {}) => ({
  url,
  t: over.t ?? 1_790_000_000_000,
  transferSize: over.transferSize ?? 500,
  encodedBodySize: over.encodedBodySize ?? 400,
});

describe("the request log: sent, fetched and blocked, this origin or not", () => {
  it("the send paths are privacy-allowlist.json's sends", () => {
    expect([...SEND_PATHS]).toEqual(JSON.parse(read("privacy-allowlist.json")).sends);
  });

  it("classifies a same-origin send, a same-origin fetch, another origin, and non-network addresses", () => {
    expect(classify(`${ORIGIN}/e`, ORIGIN)).toEqual({ path: "/e", own: true, dir: "sent" });
    expect(classify(`${ORIGIN}/feedback`, ORIGIN)).toEqual({ path: "/feedback", own: true, dir: "sent" });
    expect(classify(`${ORIGIN}/works/cave.txt`, ORIGIN)).toEqual({ path: "/works/cave.txt", own: true, dir: "fetched" });
    expect(classify(`${ORIGIN}/e/x`, ORIGIN)?.dir).toBe("fetched");
    expect(classify("https://fonts.gstatic.com/s/roboto.woff2", ORIGIN)).toEqual({ path: "https://fonts.gstatic.com/s/roboto.woff2", own: false, dir: "fetched" });
    // A look-alike host is another origin.
    expect(classify("https://dial.voidvision.org.evil.example/e", ORIGIN)?.own).toBe(false);
    expect(classify("http://dial.voidvision.org/e", ORIGIN)?.own).toBe(false);
    for (const u of ["data:image/svg+xml,x", "blob:https://dial.voidvision.org/abc", "about:blank", "inline", "eval"]) expect(classify(u, ORIGIN), u).toBeNull();
  });

  it("a fetched entry keeps its body size and marks a cache hit; another origin's hidden size is not known", () => {
    expect(fromEntry(entry(`${ORIGIN}/`), ORIGIN)).toMatchObject({ path: "/", own: true, dir: "fetched", bytes: 400 });
    expect(fromEntry(entry(`${ORIGIN}/assets/a.js`, { transferSize: 0 }), ORIGIN)?.served).toBe("cache");
    // A copy from memory reports no sizes: from the cache, size not known, never "0 B".
    expect(fromEntry(entry(`${ORIGIN}/assets/a.js`, { transferSize: 0, encodedBodySize: 0 }), ORIGIN)).toMatchObject({ served: "cache", bytes: null });
    // Answered by Dial's offline helper (workerStart > 0): the helper, never "cache", even with nothing transferred.
    expect(fromEntry({ ...entry(`${ORIGIN}/`, { transferSize: 0 }), workerStart: 12.5 }, ORIGIN)?.served).toBe("helper");
    expect(fromEntry({ ...entry(`${ORIGIN}/`), workerStart: 0 }, ORIGIN)?.served).toBeUndefined();
    // The helper's own request is marked as its own.
    expect(fromEntry(entry(`${ORIGIN}/assets/a.js`), ORIGIN, "helper")?.by).toBe("helper");
    expect(fromEntry(entry("https://cdn.example/x.js", { transferSize: 0, encodedBodySize: 0 }), ORIGIN)?.bytes).toBeNull();
  });

  it("a send is recorded by its sender; the browser's entry only confirms it, oldest first, and an unrecorded send is listed with its size not known", () => {
    expect(sentRecord("/e", 20, 1000.4, "page_view")).toEqual({ t: 1000, path: "/e", own: true, dir: "sent", bytes: 20, event: "page_view" });
    const pending = ["/e", "/feedback", "/e"];
    expect(confirmSend(fromEntry(entry(`${ORIGIN}/e`), ORIGIN)!, pending)).toBeNull();
    expect(pending).toEqual(["/feedback", "/e"]);
    expect(confirmSend(fromEntry(entry(`${ORIGIN}/feedback`), ORIGIN)!, pending)).toBeNull();
    expect(confirmSend(fromEntry(entry(`${ORIGIN}/e`), ORIGIN)!, pending)).toBeNull();
    const unrecorded = confirmSend(fromEntry(entry(`${ORIGIN}/e`), ORIGIN)!, pending);
    expect(unrecorded).toMatchObject({ dir: "sent", bytes: null });
    expect(unrecorded!.event).toBeUndefined();
    // A fetched row passes through and confirms nothing.
    const keep = ["/e"];
    expect(confirmSend(fromEntry(entry(`${ORIGIN}/`), ORIGIN)!, keep)?.bytes).toBe(400);
    expect(keep).toEqual(["/e"]);
  });

  it("the recorder writes a send at send time and keeps it; a later send keeps its own name; entries never re-pair", async () => {
    const data: Record<string, string> = {};
    const session = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
    vi.stubGlobal("window", { sessionStorage: session });
    vi.stubGlobal("location", { origin: ORIGIN });
    vi.resetModules();
    try {
      const rec = await import("../web/src/request-recorder");
      rec.noteSend("/e", 20, "page_view");
      // No entry ever arrives for this send (a failed or unrecorded request): the row stays.
      let log = rec.readLog();
      expect(log.records).toEqual([expect.objectContaining({ path: "/e", dir: "sent", bytes: 20, event: "page_view" })]);
      expect(parseLog(data[rec.LOG_KEY]!).records).toHaveLength(1);
      rec.noteSend("/e", 27, "chapter_rendered");
      // The browser's entries confirm both sends and add no row, in any order they arrive.
      rec.recordEntries([entry(`${ORIGIN}/e`, { t: 5 }), entry(`${ORIGIN}/e`, { t: 6 })]);
      log = rec.readLog();
      expect(log.records.map((r) => [r.bytes, r.event])).toEqual([
        [20, "page_view"],
        [27, "chapter_rendered"],
      ]);
      // A third entry with no send behind it is listed as it is, size not known.
      rec.recordEntries([entry(`${ORIGIN}/e`, { t: 7 })]);
      expect(rec.readLog().records.filter((r) => r.dir === "sent")).toHaveLength(3);
      expect(rec.readLog().records.find((r) => r.t === 7)?.bytes).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("sealed while every request went to this origin; a blocked request never left, so it keeps the seal; anything else opens it", () => {
    const own = fromEntry(entry(`${ORIGIN}/`), ORIGIN)!;
    const blocked = blockedRecord("https://fonts.gstatic.com/x.woff2", 2, ORIGIN)!;
    const foreign = fromEntry(entry("https://tracker.example/p.gif"), ORIGIN)!;
    expect(isSealed([])).toBe(true);
    expect(isSealed([own])).toBe(true);
    expect(isSealed([own, blocked])).toBe(true);
    expect(isSealed([own, foreign])).toBe(false);
    expect(blockedRecord("inline", 2, ORIGIN)).toBeNull();
    const s = summarize([own, blocked, foreign]);
    expect(s).toMatchObject({ fetched: 2, blocked: 1, foreign: 1, counts: 0 });
  });

  it("the summary counts sends apart from fetches, and says what it was in plain words", () => {
    const recs: RequestRecord[] = [
      { t: 3, path: "/e", own: true, dir: "sent", bytes: 20, event: "page_view" },
      { t: 1, path: "/", own: true, dir: "fetched", bytes: 3100 },
      { t: 2, path: "/voice/models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.part0", own: true, dir: "fetched", bytes: 20_971_520 },
      { t: 4, path: "/feedback", own: true, dir: "sent", bytes: null },
    ];
    const s = summarize(recs);
    expect(s).toMatchObject({ counts: 1, feedback: 1, sentBytes: 20, sentUnknown: 1, fetched: 2, fetchedBytes: 20_974_620, cached: 0, since: 1, lastSent: 4 });
    expect(whatItWas(recs[0]!)).toBe("Count: page_view");
    expect(whatItWas(recs[2]!)).toBe("Voice model, part 1");
    expect(whatItWas({ path: "/voice/voices/bm_george.bin", own: true, dir: "fetched" })).toBe("Voice: George");
    expect(whatItWas({ path: "/seal", own: true, dir: "fetched" })).toBe("The page");
    expect(sizeLabel(27)).toBe("27 B");
    expect(sizeLabel(114_600_000)).toBe("114.6 MB");
    expect(sizeLabel(null)).toBe("not known");
  });

  it("the stored log reads back only well-formed records, keeps newest last, and caps its size", () => {
    expect(parseLog(null)).toEqual({ records: [], dropped: 0 });
    expect(parseLog("{not json")).toEqual({ records: [], dropped: 0 });
    const good = { t: 1, path: "/", own: true, dir: "fetched", bytes: 1 };
    const raw = JSON.stringify({ records: [good, { ...good, dir: "evil" }, { ...good, bytes: -1 }, { ...good, t: "x" }, { ...good, event: "<b>" }], dropped: 2 });
    const back = parseLog(raw);
    expect(back.records).toHaveLength(2);
    expect(back.records[1]!.event).toBeUndefined();
    expect(back.dropped).toBe(2);
    expect(toRecord({ ...good, path: "" })).toBeNull();
    const log = appendLog({ records: [], dropped: 0 }, [{ ...good, t: 5 } as RequestRecord, { ...good, t: 2 } as RequestRecord, { ...good, t: 9 } as RequestRecord], 2);
    expect(log.records.map((r) => r.t)).toEqual([5, 9]);
    expect(log.dropped).toBe(1);
    expect(parseLog(serializeLog(log))).toEqual(log);
  });
});

describe("escaping: every rendered path, label and host", () => {
  it("a hostile path from the network or from storage renders as text", () => {
    const recs: RequestRecord[] = [
      { t: 1, path: `/works/${XSS}`, own: true, dir: "fetched", bytes: 1 },
      { t: 2, path: `https://x.example/${XSS}`, own: false, dir: "fetched", bytes: null },
      { t: 3, path: `/e?${XSS}`, own: true, dir: "sent", bytes: 5 },
      { t: 4, path: XSS, own: false, dir: "blocked", bytes: null },
    ];
    const html = logRowsHtml(recs);
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    // A stored record's path goes through the same renderer.
    const back = parseLog(JSON.stringify({ records: recs, dropped: 0 })).records;
    expect(logRowsHtml(back)).not.toContain("<img");
    const words = sealWords(summarize(recs), false, "on", XSS);
    expect(words.say).not.toContain("<img");
    expect(sealWords(summarize([recs[0]!]), true, "on", XSS).say).not.toContain("<img");
    expect(totalsHtml(summarize(recs))).not.toContain("<img");
  });
});

describe("the Seal's words are true in every state", () => {
  const page: RequestRecord = { t: new Date(2026, 8, 26, 21, 4, 7).getTime(), path: "/seal", own: true, dir: "fetched", bytes: 2900 };
  const count: RequestRecord = { t: page.t + 1000, path: "/e", own: true, dir: "sent", bytes: 20, event: "page_view" };

  it("sealed, with a count sent: names the count, its bytes, and where everything else came from", () => {
    const w = sealWords(summarize([page, count]), true, "on", "dial.voidvision.org");
    expect(w.headline).toBe("Sealed");
    expect(w.say.replace(/<[^>]+>/g, "")).toBe(
      "Since you opened Dial at 21:04, this tab has sent 1 count with no identifier and no content: 20 bytes. Everything else was fetched: 1 file from dial.voidvision.org, and it stays on this device.",
    );
  });

  it("nothing sent: says so", () => {
    expect(sealWords(summarize([page]), true, "on", "h").say.replace(/<[^>]+>/g, "")).toContain("this tab has sent nothing.");
  });

  it("counts off: says none are sent, and why earlier ones are still listed", () => {
    const say = sealWords(summarize([page, count]), true, "off", "h").say.replace(/<[^>]+>/g, "");
    expect(say).toMatch(/^Counts are off, so this tab sends none\. Counts sent before you turned them off are still listed below/);
    expect(sealWords(summarize([page]), true, "off", "h").say).not.toContain("still listed");
  });

  it("counts on: the sentence never says they are off", () => {
    expect(sealWords(summarize([page]), true, "on", "h").say).not.toContain("Counts are off");
  });

  it("a send that was not delivered is marked, and the sentence counts only delivered sends", () => {
    const lost: RequestRecord = { ...count, t: count.t + 1, event: "work_opened", failed: true };
    const s = summarize([page, count, lost]);
    expect(s).toMatchObject({ counts: 1, sentBytes: 20, failed: 1 });
    const say = sealWords(s, true, "on", "h").say.replace(/<[^>]+>/g, "");
    expect(say).toContain("this tab has sent 1 count with no identifier and no content: 20 bytes. 1 more send was not delivered: the network failed before it arrived.");
    const rows = logRowsHtml([lost]);
    expect(rows).toContain('class="sent failed"');
    expect(rows).toContain("not delivered");
    expect(totalsHtml(s).replace(/<[^>]+>/g, "")).toContain("1 count, 20 B; 1 more was not delivered");
    // markFailed marks the one send recorded at that time, and toRecord keeps the mark only on a send.
    const log = markFailed({ records: [page, count], dropped: 0 }, count.t, "/e");
    expect(log.records[1]!.failed).toBe(true);
    expect(markFailed(log, 1, "/e")).toBe(log);
    expect(toRecord({ ...count, failed: true })?.failed).toBe(true);
    expect(toRecord({ ...page, failed: true })?.failed).toBeUndefined();
    expect(toRecord({ ...page, served: "elsewhere" })?.served).toBeUndefined();
  });

  it("once old records were dropped, the log no longer starts when Dial was opened: only \"Since\"", () => {
    const say = sealWords(summarize([page, count]), true, "on", "h", 12).say.replace(/<[^>]+>/g, "");
    expect(say).toMatch(/^Since 21:04, this tab has sent/);
    expect(say).not.toContain("opened Dial");
    expect(footHtml(true, 12)).toContain("<span data-numeral>12</span> requests are no longer listed");
    expect(footHtml(true, 1)).toContain("request is no longer listed");
    expect(footHtml(true, 0)).toBe("Newest last. Nothing has been sent to any other address.");
    expect(footHtml(false, 0)).toContain("Marked rows went to another address.");
  });

  it("cached and helper-served files are counted, but add nothing to what crossed the network", () => {
    const cached: RequestRecord = { t: page.t + 5, path: "/assets/a.js", own: true, dir: "fetched", bytes: 9000, served: "cache" };
    const helped: RequestRecord = { t: page.t + 6, path: "/assets/b.js", own: true, dir: "fetched", bytes: 7000, served: "helper" };
    const byHelper: RequestRecord = { t: page.t + 7, path: "/assets/c.js", own: true, dir: "fetched", bytes: 1000, by: "helper" };
    const s = summarize([page, cached, helped, byHelper]);
    expect(s).toMatchObject({ fetched: 4, fetchedBytes: 3900, cached: 1, helper: 1 });
    expect(totalsHtml(s).replace(/<[^>]+>/g, "").replace("&middot;", "·")).toBe(
      "Sent: nothing · Fetched: 4 files, 3.9 kB over the network; 1 from this device's cache and 1 from Dial's offline helper",
    );
    const rows = logRowsHtml([cached, helped, byHelper]).replaceAll("&#39;", "'");
    expect(rows).toContain("from this device's cache");
    expect(rows).toContain("from Dial's offline helper");
    expect(rows).toContain("requested by Dial's offline helper");
    // Only a true HTTP-cache hit says "cache".
    expect(logRowsHtml([helped])).not.toMatch(/device&#39;s cache/);
  });

  it("blocked: still sealed; another origin: open, and says it should not be possible", () => {
    expect(sealWords(summarize([page, blockedRecord("https://x.example/a", 5, ORIGIN)!]), true, "on", "h").headline).toBe("Still sealed");
    const open = sealWords(summarize([page, fromEntry(entry("https://x.example/a"), ORIGIN)!]), false, "on", "h");
    expect(open.headline).toBe("Open");
    expect(open.say).toContain("this should not be possible");
  });

  it("an unpaired send's size is not claimed", () => {
    const say = sealWords(summarize([page, { ...count, bytes: null }]), true, "on", "h").say;
    expect(say).not.toContain("bytes");
  });
});

// ---- The counts switch -------------------------------------------------------

function memoryStore(init: Record<string, string> = {}): SettingStore & { data: Record<string, string> } {
  const data = { ...init };
  return { data, getItem: (k) => (k in data ? data[k]! : null), setItem: (k, v) => void (data[k] = v) };
}

function deps(store: SettingStore | null, fails = false) {
  const fetch = vi.fn((_input: string, _init: RequestInit) => (fails ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(new Response(null, { status: 202 }))));
  const note = vi.fn((path: string, _bytes: number, _event?: string) => ({ t: 1, path }));
  const failed = vi.fn();
  return { d: { fetch, store, note, failed } satisfies SendDeps, fetch, note, failed };
}

describe("the counts switch stops every sendEvent", () => {

  it("on by default: each count posts {name} to /e as same-origin JSON, and notes its size for the log", () => {
    const { d, fetch, note } = deps(memoryStore());
    sendEvent("page_view", d);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/e");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"page_view"}');
    expect(note).toHaveBeenCalledWith("/e", 20, "page_view");
  });

  it("off: page_view, work_opened and chapter_rendered all post nothing, and note nothing", () => {
    const store = memoryStore();
    expect(setCounts(false, store)).toBe(true);
    expect(store.data[COUNTS_KEY]).toBe("off");
    const { d, fetch, note } = deps(store);
    for (const name of JSON.parse(JSON.stringify(parseYaml(read("contract.yaml")).events.allowed)) as string[]) sendEvent(name, d);
    for (const name of ["page_view", "work_opened", "chapter_rendered"]) sendEvent(name, d);
    expect(fetch).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    // Back on: counts go again.
    setCounts(true, store);
    sendEvent("page_view", d);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a send the network drops is marked not delivered; a delivered one is not", async () => {
    const lost = deps(memoryStore(), true);
    sendEvent("work_opened", lost.d);
    await new Promise((r) => setTimeout(r, 0));
    expect(lost.failed).toHaveBeenCalledWith({ t: 1, path: "/e" });
    const ok = deps(memoryStore());
    sendEvent("work_opened", ok.d);
    await new Promise((r) => setTimeout(r, 0));
    expect(ok.failed).not.toHaveBeenCalled();
  });

  it("the setting lives under one key; storage that refuses changes nothing, and the Seal disables the switch", () => {
    expect(COUNTS_KEY).toBe("dial.counts");
    expect(countsOn(memoryStore({ [COUNTS_KEY]: "off" }))).toBe(false);
    expect(countsOn(memoryStore({ [COUNTS_KEY]: "on" }))).toBe(true);
    expect(countsOn(memoryStore())).toBe(true);
    const refusing: SettingStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(setCounts(false, refusing)).toBe(false);
    // Nothing changed: counts are still on, and still send.
    const { d, fetch } = deps(refusing);
    sendEvent("chapter_rendered", d);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(setCounts(false, null)).toBe(false);
    expect(countsOn(null)).toBe(true);
    expect(canKeepSetting(null)).toBe(false);
    expect(canKeepSetting(memoryStore())).toBe(true);
    expect(STORAGE_REFUSED).toBe("This browser will not keep the setting, so Dial cannot turn counts off here.");
    expect(read("web/src/seal-widget.ts")).toMatch(/if \(!canKeepSetting\(\)\) refuse\(\);/);
    expect(read("web/src/seal-widget.ts")).toMatch(/if \(!kept\) refuse\(\);/);
  });

  it("every count in web/src goes through telemetry.ts sendEvent: no other /e sender, no second definition", () => {
    const files = (readdirSync(path.join(root, "web/src"), { recursive: true, encoding: "utf8" }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => f.split(path.sep).join("/"));
    for (const f of files) {
      const src = read(`web/src/${f}`);
      if (f !== "telemetry.ts") {
        expect(src, f).not.toMatch(/fetch\(\s*["'`]\/e["'`]/);
        expect(src, f).not.toMatch(/function sendEvent\b/);
      }
      if (/\bsendEvent\(/.test(src) && f !== "telemetry.ts") expect(src, f).toMatch(/import \{[^}]*\bsendEvent\b[^}]*\} from "\.\/telemetry";/);
    }
    expect(read("web/src/telemetry.ts")).toMatch(/export function sendEvent\(name: string, deps: SendDeps = defaults\(\), retries = 1\): void \{\s*if \(!countsOn\(deps\.store\)\) return;/);
  });
});

// ---- The speed of this device ---------------------------------------------------

describe("speed of this device: processor only, results never sent", () => {
  it("speed is seconds of speech per second of work; Dial plans on 80% of it", () => {
    expect(speedOf(3, 1000)).toBe(3);
    expect(speedOf(3, 0)).toBe(0);
    // Kept for T7; not in the copy until the radio plans on it.
    expect(PLANNING_MARGIN).toBe(0.8);
    expect(plannedSpeed(1.1)).toBeCloseTo(0.88);
    expect(speedLabel(1.1)).toBe("1.1×");
    expect(speedLabel(0.88)).toBe("0.88×");
    // The 1.00× edge: just under 1 reads "1.0×" and "as fast as real time", never "1.00×, slower".
    expect(speedLabel(0.996)).toBe("1.0×");
    expect(speedLabel(0.994)).toBe("0.99×");
    expect(verdictHtml(0.996).replace(/<[^>]+>/g, "")).toBe("Dial will use the processor: 1.0×, as fast as real time.");
    expect(verdictHtml(1.04).replace(/<[^>]+>/g, "")).toBe("Dial will use the processor: 1.0×, as fast as real time.");
    expect(verdictHtml(1.1).replace(/<[^>]+>/g, "")).toBe("Dial will use the processor: 1.1×, faster than real time.");
    expect(verdictHtml(0.7).replace(/<[^>]+>/g, "")).toBe("Dial will use the processor: 0.70×, slower than real time.");
    expect(verdictHtml(1.02).replace(/<[^>]+>/g, "")).toBe("Dial will use the processor: 1.0×, as fast as real time.");
    // No planning claim reaches the page before T7.
    for (const x of [0.5, 1, 3]) expect(verdictHtml(x)).not.toMatch(/plan|80|margin/i);
    for (const f of ["web/index.html", "web/src/seal-widget.ts"]) expect(read(f), f).not.toMatch(/plans on|80%|PLANNING_MARGIN|plannedSpeed/);
  });

  it("before the click, the button line states what the test will download, by the radio's size rules", () => {
    expect(benchNeedLine(0, "none", 0)).toBe("The voice looks to be on this device already.");
    expect(benchNeedLine(114_527_513, "all", 1)).toBe("The test downloads the voice once (about 115 MB) and keeps it on this device.");
    expect(benchNeedLine(522_240, "voices", 1)).toBe("The test adds its voice to this device first (about 1 MB).");
    expect(benchNeedLine(NaN, "all")).toBe("The test downloads the voice first if it is not on this device.");
    expect(benchNeedLine(null, null)).toBe("The test downloads the voice first if it is not on this device.");
    // A presence-only look (voice-files.ts voicePresence), for T7's gauge: no hashing, and no cache opened that does not exist.
    const files = read("web/src/voice-files.ts");
    const presence = files.slice(files.indexOf("export async function voicePresence"));
    expect(presence).not.toMatch(/sha256Hex|arrayBuffer|dropIfUnpinned|\.put\(|\.delete\(/);
    expect(presence).toMatch(/const open = \(name: string\) => \(names\.has\(name\) \? caches\.open\(name\) : Promise\.resolve\(null\)\);/);
    expect(presence).not.toMatch(/caches\.open\((?!name)/);
  });

  it("threads and isolation come from what the browser reports; timings appear only after a run", () => {
    expect(reportsHtml(8).replace(/<[^>]+>/g, "")).toBe("This browser reports 8 processor threads.");
    expect(reportsHtml(undefined)).toBe("This browser does not report its processor threads.");
    const before = cpuDetailsHtml(8, true).replace(/<[^>]+>/g, " ");
    expect(before).toContain("Cross-origin isolated");
    expect(before).not.toContain("Voice load");
    const after = cpuDetailsHtml(8, false, { loadMs: 3400, firstMs: 2900, audioSeconds: 3.2 }).replace(/<[^>]+>/g, " ");
    expect(after).toMatch(/Voice load\s+3\.4 s\s+First sentence\s+2\.9 s/);
  });

  it("a stopped test speaks plain words and says to run it again, never Tune in", () => {
    for (const raw of ["TypeError: Failed to fetch", "Error: voice part x: 503", "QuotaExceededError: no room", "Error: weird"]) {
      expect(benchStopLine(raw)).not.toMatch(/Tune in|Error|fetch/);
    }
  });

  it("no send in the test's path: the render worker's speed test posts only timings and counts nothing", () => {
    const worker = read("web/src/narrate.worker.ts");
    const loop = read("web/src/speed/render-loop.ts");
    const testFn = loop.slice(loop.indexOf("async function timeSentence("), loop.indexOf("export class RenderLoop"));
    for (const [name, src] of [["bench.ts", read("web/src/bench.ts")], ["speed test", testFn], ["narrate.worker.ts", worker]] as const) {
      expect(src, name).not.toMatch(/sendEvent|reportCoreSuccess|fetch\(|sendBeacon|\/e\b|noteSend/);
    }
    // It times the one fixed sentence on each engine it compares, with the voice already loaded.
    expect(testFn).toMatch(/await guard\(say\(tts, BENCH_SENTENCE, voice\), BENCH_SENTENCE\)/);
    // The worker never loads the page's rendering code or the voice table (types only), and the sentence has its own module.
    expect(worker).not.toMatch(/^import \{[^}]*\} from "\.\/(engine\/cast|bench|render)";$/m);
    expect(loop).not.toMatch(/^import \{[^}]*\} from "\.\.\/(engine\/cast|bench|render)";$/m);
    expect(loop).toContain('import { BENCH_SENTENCE } from "../bench-sentence";');
  });

  it("T7's gauge fills the slot on the glass, from the render worker's speed and every line made; the Seal widget starts nothing", () => {
    const html = read("web/index.html");
    expect(html).toContain('<div class="inst gauge-inst" id="speed-gauge" hidden></div>');
    expect(read("web/src/main.ts")).toContain('const gauge = mountGauge(gaugeSlot);');
    for (const f of ["seal-widget.ts", "panels-ui.ts"]) expect(read(`web/src/${f}`), f).not.toMatch(/mountGauge|Pacer|benchNeedLine|speedHtml/);
  });
});

describe("the Seal widget on the radio (T8, design/spec.md 00)", () => {
  const html = read("web/index.html");
  const at = new Date(2026, 8, 27, 21, 26, 5).getTime();
  const count = (t: number, over: Partial<RequestRecord> = {}): RequestRecord => ({ t, path: "/e", own: true, dir: "sent", bytes: 20, event: "page_view", ...over });
  const flat = (h: string) => h.replace(/<[^>]+>/g, "");

  it("replaced the page: no /seal page, no Seal room link, the contract checks /seal is gone and the widget's words are served", () => {
    expect(() => read("web/seal.html")).toThrow();
    expect(read("web/vite.config.ts")).not.toMatch(/seal/);
    expect(html).not.toMatch(/href="\/seal"/);
    expect(html).toMatch(/<nav class="rooms" aria-label="Rooms">\s*<a href="\/" id="room-repertory" aria-current="page"><span>Radio<\/span>/);
    const checks = parseYaml(read("contract.yaml")).checks as { path: string; type: string; expect?: number; text?: string }[];
    expect(checks.some((c) => c.path === "/seal" && c.type === "status" && c.expect === 404)).toBe(true);
    expect(checks.some((c) => c.path === "/seal" && c.expect === 200)).toBe(false);
    for (const text of ["Send anonymous counts", "Show every request"]) expect(checks.some((c) => c.path === "/" && c.type === "contains" && c.text === text), text).toBe(true);
  });

  it("is a widget on the work panel: the eye, one sentence, today's counts, the switch, and every request collapsed", () => {
    const seal = /<article class="widget w-seal" id="seal"[\s\S]*?<\/article>/.exec(html)![0];
    expect(html.slice(html.indexOf('<section class="panel p-work" id="work"'), html.indexOf("</main>"))).toContain(seal);
    expect(seal).toContain('<svg class="seye" id="seal-eye"');
    expect(seal).toContain('role="switch"');
    // Collapsed by default: no file names in the default view.
    expect(seal).toMatch(/<details class="reqs-box" id="seal-reqs">\s*<summary><span class="sh">Show every request<\/span><span class="hd">Hide the requests<\/span><\/summary>/);
    expect(seal).not.toMatch(/<details[^>]* open/);
    // Every "check it" link lands on the work panel, where the widget is.
    expect(read("web/src/panels-ui.ts")).toContain('new URLSearchParams(location.search).get("panel") === "work"');
  });

  it("reads before it claims: \"Reading this tab\" until the browser's first batch arrives; sealed only while it is", () => {
    const s0 = summarize([]);
    expect(flat(sealLineHtml(s0, true, false, "h"))).toBe("Reading this tab. Collecting the browser's record of every request this page has made.");
    expect(flat(sealLineHtml(s0, true, true, "h"))).toBe("Sealed. Nothing you hear or make leaves this device.");
    const blocked = summarize([blockedRecord("https://x.example/a", 5, ORIGIN)!]);
    expect(flat(sealLineHtml(blocked, true, true, "h"))).toBe("Still sealed. Nothing you hear or make leaves this device. The browser blocked 1 request to another site before it left.");
    const foreign = summarize([fromEntry(entry("https://x.example/a"), ORIGIN)!]);
    const open = flat(sealLineHtml(foreign, false, true, "h"));
    expect(open).toMatch(/^Open\. This tab made 1 request to another address/);
    expect(open).not.toContain("Nothing you hear or make leaves");
    const widget = read("web/src/seal-widget.ts");
    expect(widget).toMatch(/let ready = typeof PerformanceObserver !== "function";\s*const render = /);
    expect(widget).toMatch(/recordRequests\(\(\) => \{\s*ready = true;/);
    expect(widget).not.toMatch(/setTimeout\(render/);
  });

  it("today's counts are this tab's delivered counts since local midnight, and say so", () => {
    const yesterday = new Date(2026, 8, 26, 23, 50).getTime();
    const recs = [count(yesterday), count(at - 60_000), count(at - 30_000, { event: "work_opened" }), count(at - 20_000, { failed: true }), { ...count(at - 10_000), path: "/feedback", event: undefined }];
    const today = countsToday(recs, at);
    expect(today.n).toBe(2);
    expect(today.last).toBe(at - 30_000);
    expect(flat(countLineHtml(today, "on"))).toBe("Today Dial sent 2 anonymous counts from this tab.");
    expect(flat(countLineHtml(countsToday([count(at)], at), "on"))).toBe("Today Dial sent 1 anonymous count from this tab.");
    expect(flat(countLineHtml(countsToday([count(yesterday)], at), "on"))).toBe("No counts sent today from this tab.");
    expect(flat(countLineHtml(countsToday([], at), "on"))).toBe("No counts sent today from this tab.");
    // Counts off: nothing since the last count, at its time; never "Today Dial sent".
    const off = flat(countLineHtml(countsToday([count(new Date(2026, 8, 27, 21, 26).getTime())], at), "off"));
    expect(off).toBe("Counts are off. No count has been sent from this tab since 21:26.");
    expect(flat(countLineHtml(countsToday([], at), "off"))).toBe("Counts are off. No count has been sent from this tab today.");
    // Old records let go, the oldest kept one from today: the number is a floor.
    expect(flat(countLineHtml(countsToday([count(at - 5000)], at, 40), "on"))).toBe("Today Dial sent at least 1 anonymous count from this tab.");
    expect(flat(countLineHtml(countsToday([count(yesterday), count(at)], at, 40), "on"))).toBe("Today Dial sent 1 anonymous count from this tab.");
    expect(countLineHtml(countsToday([count(at)], at), "on")).toContain('<span data-numeral>1</span>');
  });

  it("the list's sentence is true: what was fetched, what was sent, nowhere else", () => {
    const own = fromEntry(entry(`${ORIGIN}/`), ORIGIN)!;
    expect(flat(requestsIntroHtml(summarize([own, count(at)]), true, "dial.voidvision.org"))).toBe("Everything this tab fetched from dial.voidvision.org, and the counts it sent. Nothing went anywhere else. Check it yourself in your browser's developer tools, Network tab.");
    expect(flat(requestsIntroHtml(summarize([own, { ...count(at), path: "/feedback", event: undefined }]), true, "h"))).toContain("and the counts and feedback it sent");
    expect(flat(requestsIntroHtml(summarize([own, fromEntry(entry("https://x.example/a"), ORIGIN)!]), false, "h"))).not.toContain("Nothing went anywhere else");
    expect(requestsIntroHtml(summarize([own]), true, XSS)).not.toContain("<img");
    expect(sealLineHtml(summarize([fromEntry(entry("https://x.example/a"), ORIGIN)!]), false, true, XSS)).not.toContain("<img");
  });

  it("sends and counts nothing of its own, and does no work in a hidden tab", () => {
    const widget = read("web/src/seal-widget.ts");
    expect(widget).not.toMatch(/sendEvent|reportCoreSuccess|page_view|fetch\(/);
    expect(widget).toMatch(/setInterval\(\(\) => \{\s*if \(!document\.hidden\) render\(\);\s*\}, 60_000\);/);
  });

  it("says what it cannot see, beside the list, and the list scrolls inside itself", () => {
    const list = /<div class="reqs" tabindex="0" role="region" aria-label="Every request this tab made">[\s\S]*?<\/table>/.exec(html)![0];
    expect(list).toContain("Browser extensions and the browser's own services run outside the page, so the Seal cannot see them.");
    expect(list).toContain('<tbody id="log"></tbody>');
  });
});

// ---- The offline helper's rows: once per tab, and only the tab's own ----------

describe("the offline helper's requests: each tab gets its own, once", () => {
  const e = (url: string, t: number) => ({ url, t, transferSize: 100, encodedBodySize: 90 });

  it("an entry is claimed by the page the helper fetched it for; one nobody claimed is shared", () => {
    const pending: PendingFetch[] = [
      { url: `${ORIGIN}/works/cave.txt`, at: 1000, clientId: "tab-a" },
      { url: `${ORIGIN}/works/cave.txt`, at: 1500, clientId: "tab-b" },
      { url: `${ORIGIN}/`, at: 1200, clientId: "new-page" },
    ];
    expect(claim(pending, e(`${ORIGIN}/works/cave.txt`, 1003))).toBe("tab-a");
    expect(claim(pending, e(`${ORIGIN}/works/cave.txt`, 1501))).toBe("tab-b");
    // The shell the helper keeps for itself was noted for no page.
    expect(claim(pending, e(`${ORIGIN}/assets/main.js`, 1100))).toBeNull();
    // Before the note started: not claimed.
    expect(claim(pending, e(`${ORIGIN}/`, 1000))).toBeNull();
    // A slow response is still claimed while its note lives, however long after the start.
    expect(claim(pending, e(`${ORIGIN}/`, 1200 + 45_000))).toBe("new-page");
  });

  it("claims by the closest start, not the oldest note", () => {
    const pending: PendingFetch[] = [
      { url: "/voice/manifest.json", at: 1000, clientId: "tab-a" },
      { url: "/voice/manifest.json", at: 5000, clientId: "tab-b" },
    ];
    expect(claim(pending, e("/voice/manifest.json", 5002))).toBe("tab-b");
    expect(claim(pending, e("/voice/manifest.json", 5003))).toBe("tab-a");
  });

  it("a note is dropped a grace period after its response arrived, not by its start; one that never settles goes after the cap", () => {
    const pending: PendingFetch[] = [
      { url: "/big", at: 0, clientId: "a" },
      { url: "/small", at: 0, clientId: "b" },
      { url: "/lost", at: -100_000, clientId: "c" },
    ];
    settle(pending, "/big", "a", 200_000);
    settle(pending, "/small", "b", 100);
    settle(pending, "/other", "b", 100);
    prune(pending, 200_000 + SETTLED_GRACE_MS - 1);
    // /big started long ago but settled recently: kept. /small settled long ago: dropped. /lost never settled and passed the cap: dropped.
    expect(pending.map((p) => p.url)).toEqual(["/big"]);
    const lost: PendingFetch[] = [{ url: "/lost", at: 0, clientId: "c" }];
    prune(lost, UNSETTLED_MAX_MS - 1);
    expect(lost).toHaveLength(1);
    prune(lost, UNSETTLED_MAX_MS + 1);
    expect(lost).toHaveLength(0);
  });

  it("an entry claimed by a render worker goes to the page that started it: never dropped, never shared", () => {
    const owners = new Map([["worker-1", "tab-a"]]);
    expect(ownerOf(owners, "worker-1")).toBe("tab-a");
    expect(ownerOf(owners, "tab-b")).toBe("tab-b");
    const pending: PendingFetch[] = [
      { url: "/voice/manifest.json", at: 100, clientId: "worker-1" },
      { url: "/ort/ort-wasm-simd-threaded.jsep.mjs", at: 110, clientId: "worker-1" },
    ];
    const entries = [e("/voice/manifest.json", 101), e("/ort/ort-wasm-simd-threaded.jsep.mjs", 111)];
    const claimed = entries.map((entry) => ({ entry, clientId: claim(pending, entry) }));
    expect(claimed.map((c) => c.clientId)).toEqual(["worker-1", "worker-1"]);
    const g = groupByClient(claimed, owners);
    expect([...g.own.keys()]).toEqual(["tab-a"]);
    expect(g.own.get("tab-a")!.map((x) => x.url)).toEqual(["/voice/manifest.json", "/ort/ort-wasm-simd-threaded.jsep.mjs"]);
    expect(g.shared).toEqual([]);
    // A page that asks later is answered with its worker's entries too.
    expect(answerFor(claimed, "tab-a", 0, 0, owners).own).toHaveLength(2);
    expect(answerFor(claimed, "tab-b", 0, 0, owners).own).toHaveLength(0);
    expect(answerFor(claimed, "tab-a", 0, 0, owners).shared).toHaveLength(0);
    // The helper notes the owner from the worker's script request, before routing.
    const sw = read("web/src/sw.ts");
    expect(sw).toMatch(/if \(request\.destination === "worker" && event\.resultingClientId && event\.clientId\) startedBy\(event\.resultingClientId, event\.clientId\);\s*const r = route\(/);
    expect(sw).toContain("groupByClient(claimed, owners)");
    expect(sw).toMatch(/answerFor\(memory, source\.id, time\(data\.afterOwn\), time\(data\.afterShared\), owners\)/);
    // Every fetch the helper makes for a client settles its note when the response arrives.
    expect([...sw.matchAll(/fetch\(request\)\.finally\(\(\) => settled\(request, client\)\)/g)]).toHaveLength(3);
  });

  it("each page is sent only its own entries; the shared go to every page, marked; a page that asks gets only what is newer", () => {
    const list: HelperEntry[] = [
      { entry: e("/a", 10), clientId: "tab-a" },
      { entry: e("/b", 11), clientId: "tab-b" },
      { entry: e("/shell.js", 12), clientId: null },
      { entry: e("/a2", 13), clientId: "tab-a" },
    ];
    const g = groupByClient(list);
    expect(g.own.get("tab-a")!.map((x) => x.url)).toEqual(["/a", "/a2"]);
    expect(g.own.get("tab-b")!.map((x) => x.url)).toEqual(["/b"]);
    expect(g.shared.map((x) => x.url)).toEqual(["/shell.js"]);
    const answer = answerFor(list, "tab-a", 10, 0);
    expect(answer.own.map((x) => x.url)).toEqual(["/a2"]);
    expect(answer.shared.map((x) => x.url)).toEqual(["/shell.js"]);
    // Own and shared are asked for apart: shared rows already held are not sent again, own ones still are.
    const apart = answerFor(list, "tab-a", 0, 12);
    expect(apart.own.map((x) => x.url)).toEqual(["/a", "/a2"]);
    expect(apart.shared).toEqual([]);
    expect(answerFor(list, "tab-c", 0, 0).own).toEqual([]);
    const memory: HelperEntry[] = [];
    remember(memory, Array.from({ length: HELPER_MEMORY + 5 }, (_, i) => ({ entry: e(`/${i}`, i), clientId: null })));
    expect(memory).toHaveLength(HELPER_MEMORY);
    expect(memory[0]!.entry.url).toBe("/5");
  });

  it("the log keeps a helper row once, by time, path, by and direction; other rows pass", () => {
    const row: RequestRecord = { t: 1000.4, path: "/assets/a.js", own: true, dir: "fetched", bytes: 9, by: "shared" };
    const log = { records: [{ ...row, t: 1000 }], dropped: 0 };
    expect(newHelperRows(log, [row])).toEqual([]);
    expect(newHelperRows(log, [{ ...row, by: "helper" }])).toHaveLength(1);
    expect(newHelperRows(log, [row, row].map((r) => ({ ...r, t: 2000 })))).toHaveLength(1);
    const page: RequestRecord = { t: 1000, path: "/assets/a.js", own: true, dir: "fetched", bytes: 9 };
    expect(newHelperRows(log, [page])).toEqual([page]);
    expect(newestHelperRow(log, "shared")).toBe(1000);
    expect(newestHelperRow(log, "helper")).toBe(0);
    expect(newestHelperRow({ records: [page], dropped: 0 }, "shared")).toBe(0);
    expect(read("web/src/request-recorder.ts")).toContain('afterOwn: newestHelperRow(log, "helper"), afterShared: newestHelperRow(log, "shared")');
  });

  it("the same helper batch through two pages of one tab gives one copy", async () => {
    const data: Record<string, string> = {};
    const session = { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) };
    vi.stubGlobal("window", { sessionStorage: session });
    vi.stubGlobal("location", { origin: ORIGIN });
    const batch = [e(`${ORIGIN}/assets/main.js`, 5_000), e(`${ORIGIN}/`, 5_001)];
    try {
      for (const _page of [1, 2]) {
        // A fresh module per page load: its own memory of what it saw, the tab's storage shared.
        vi.resetModules();
        const rec = await import("../web/src/request-recorder");
        rec.recordEntries(batch, "shared");
        rec.recordEntries(batch, "shared");
      }
      const rows = parseLog(data["dial.requests"]!).records;
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.by === "shared")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("shared downloads are counted apart from this tab's own, and labelled", () => {
    const own: RequestRecord = { t: 1, path: "/", own: true, dir: "fetched", bytes: 3000 };
    const mine: RequestRecord = { t: 2, path: "/works/cave.txt", own: true, dir: "fetched", bytes: 16000, by: "helper" };
    const shared: RequestRecord = { t: 3, path: "/assets/main.js", own: true, dir: "fetched", bytes: 34000, by: "shared" };
    const s = summarize([own, mine, shared]);
    expect(s).toMatchObject({ fetched: 2, fetchedBytes: 19000, shared: 1, sharedBytes: 34000 });
    expect(totalsHtml(s).replace(/<[^>]+>/g, "")).toContain("Offline helper, shared by every tab: 1 file, 34.0 kB");
    expect(sealWords(s, true, "on", "h").say.replace(/<[^>]+>/g, "")).toContain(
      "Dial's offline helper, which every Dial tab shares, also fetched 1 file of this site's own for itself.",
    );
    const rows = logRowsHtml([mine, shared]).replaceAll("&#39;", "'");
    expect(rows).toContain("requested by Dial's offline helper for this tab");
    expect(rows).toContain("made by the offline helper, which every Dial tab shares");
    expect(toRecord({ ...shared })?.by).toBe("shared");
    expect(toRecord({ ...shared, by: "someone" })?.by).toBeUndefined();
  });
});
