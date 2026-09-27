// T9: fixes from the pre-Proof audit (security, performance, accessibility
// and copy lenses, 2026-09-26) that live on the page: the feedback form's
// checks and words, the Bookplate's Direction line, the render meter's name,
// the Seal switch's sentence, and the model stitched in one buffer. Each
// block fails without its fix.

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKS } from "../web/src/catalogue";
import {
  FEEDBACK_DAY_FULL,
  FEEDBACK_EMPTY,
  FEEDBACK_FAILED,
  FEEDBACK_TOO_LONG,
  FEEDBACK_TOO_MANY,
  MAX_FEEDBACK_BYTES,
  feedbackFailure,
  feedbackProblem,
} from "../web/src/feedback-copy";
import { bookplateHtml, directionSentence } from "../web/src/render";
import { METER_MAKING, METER_WARMING } from "../web/src/status-copy";
import { retryDelayMs, sendEvent, setCounts, type SendDeps } from "../web/src/telemetry";
import { cachedPinnedFile, fetchPinnedFile, modelFilePin, partPath, pinnedModelCache, preparePinnedFiles, putPinnedFile, readInto, stitchModel } from "../web/src/voice-files";
import { MAX_FEEDBACK_TEXT_BYTES } from "../worker/src/config";
import { handleFeedback, type Env } from "../worker/src/index";
import { createMockAssets, createMockD1 } from "./helpers/mock-d1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const main = read("web/src/main.ts");
const html = read("web/index.html");

describe("the feedback form checks on the page, and every refusal says what to do", () => {
  it("uses the Worker's own byte cap, counted in UTF-8 bytes after trimming, as the Worker does", () => {
    expect(MAX_FEEDBACK_BYTES).toBe(MAX_FEEDBACK_TEXT_BYTES);
    expect(feedbackProblem("   ")).toBe(FEEDBACK_EMPTY);
    expect(feedbackProblem("A sentence.")).toBeNull();
    expect(feedbackProblem(`  ${"x".repeat(4000)}  `)).toBeNull();
    expect(feedbackProblem("x".repeat(4001))).toBe(FEEDBACK_TOO_LONG);
    // 1,500 characters of Greek are 3,000 bytes, and fit; 2,000 of them (the textarea's maxlength) are 4,000 and fit; 1,400 emoji are 5,600 and do not.
    expect(feedbackProblem("α".repeat(2000))).toBeNull();
    expect(feedbackProblem("\u{1F600}".repeat(1400))).toBe(FEEDBACK_TOO_LONG);
    // The case the audit found: CJK text within the textarea's 2,000 characters is up to 6,000 bytes.
    const cjk = "漢".repeat(1500);
    expect(cjk.length).toBeLessThanOrEqual(Number(/<textarea id="feedback-text"[^>]*maxlength="(\d+)"/.exec(html)![1]));
    expect(feedbackProblem(cjk)).toBe(FEEDBACK_TOO_LONG);
  });

  it("what the page lets through, the Worker accepts; what it stops, the Worker would refuse", async () => {
    const env = (): Env => ({ DB: createMockD1().db, ASSETS: createMockAssets() });
    const post = (text: string) => new Request("http://internal/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, page: "/" }) });
    for (const text of ["hi", "x".repeat(4000), "α".repeat(2000), "\u{1F600}".repeat(1000), "\u{1F600}".repeat(1001), "   "]) {
      const pageOk = feedbackProblem(text) === null;
      const status = (await handleFeedback(post(text), env())).status;
      expect(status === 202, `${text.slice(0, 8)}... (${text.length})`).toBe(pageOk);
    }
  });

  it("a 429 from the day's shared ceiling is not the per-network limit; too long gets the fix, not 'try again'", () => {
    expect(feedbackFailure(429, "daily_ceiling_reached")).toBe(FEEDBACK_DAY_FULL);
    expect(feedbackFailure(429, "rate_limited")).toBe(FEEDBACK_TOO_MANY);
    // The zone's own block (Cloudflare 1015) is an HTML 429 with no code.
    expect(feedbackFailure(429, undefined)).toBe(FEEDBACK_TOO_MANY);
    expect(feedbackFailure(400, "feedback_too_long")).toBe(FEEDBACK_TOO_LONG);
    expect(feedbackFailure(400, "invalid_feedback")).toBe(FEEDBACK_EMPTY);
    expect(feedbackFailure(503, "unavailable")).toBe(FEEDBACK_FAILED);
    expect(FEEDBACK_TOO_LONG).toBe("That message is too long. Shorten it, then send again.");
    expect(FEEDBACK_TOO_MANY).toBe("Too many messages from this network. Wait a minute, then send again.");
    expect(FEEDBACK_DAY_FULL).toBe("We have had a lot of feedback today. Please try again tomorrow.");
  });

  it("the form checks before it sends, marks the field, reads the Worker's error code, and never says 'tomorrow' for every 429", () => {
    const fb = main.slice(main.indexOf("function setupFeedback"));
    expect(fb).toMatch(/const problem = feedbackProblem\(text\);\s*if \(problem\) \{\s*refuse\(problem\);/);
    expect(fb.indexOf("feedbackProblem(text)")).toBeLessThan(fb.indexOf('fetch("/feedback"'));
    expect(fb).toContain('textarea.setAttribute("aria-invalid", "true");');
    expect(fb).toContain("refuse(feedbackFailure(response.status, typeof body?.error === \"string\" ? body.error : undefined));");
    expect(fb).not.toMatch(/status === 429/);
    expect(fb).not.toContain("lot of feedback");
  });

  it("no em dash in any of the form's words", () => {
    for (const line of [FEEDBACK_EMPTY, FEEDBACK_TOO_LONG, FEEDBACK_DAY_FULL, FEEDBACK_TOO_MANY, FEEDBACK_FAILED]) expect(line).not.toContain("—");
  });
});

describe("a count refused on a shared network is tried once more, after Retry-After (CoS decision K)", () => {
  const setup = (statuses: number[], retryAfter: string | null = "60") => {
    const store = { data: {} as Record<string, string>, getItem(k: string) { return this.data[k] ?? null; }, setItem(k: string, v: string) { this.data[k] = v; } };
    const queued: { ms: number; fn: () => void }[] = [];
    const fetch = vi.fn(async () => new Response(null, { status: statuses.shift() ?? 202, headers: retryAfter ? { "retry-after": retryAfter } : {} }));
    const failed = vi.fn();
    const d: SendDeps = { fetch, store, note: () => ({ t: 1, path: "/e" }) as never, failed, later: (ms, fn) => void queued.push({ ms, fn }) };
    return { d, fetch, failed, queued, store };
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("one retry per count, after the answer's Retry-After; a second refusal is not retried", async () => {
    const s = setup([429, 429]);
    sendEvent("chapter_rendered", s.d);
    await settle();
    expect(s.queued).toHaveLength(1);
    expect(s.queued[0]!.ms).toBe(60_000);
    expect(s.failed).toHaveBeenCalledTimes(1);
    s.queued.shift()!.fn();
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.queued).toHaveLength(0);
    expect(s.failed).toHaveBeenCalledTimes(2);
  });

  it("a retry that lands is counted once; an accepted count is never retried; the switch is read again before the retry", async () => {
    const ok = setup([429, 202]);
    sendEvent("page_view", ok.d);
    await settle();
    ok.queued.shift()!.fn();
    await settle();
    expect(ok.fetch).toHaveBeenCalledTimes(2);
    expect(ok.queued).toHaveLength(0);
    const accepted = setup([202]);
    sendEvent("page_view", accepted.d);
    await settle();
    expect(accepted.queued).toHaveLength(0);
    const off = setup([429]);
    sendEvent("work_opened", off.d);
    await settle();
    setCounts(false, off.store);
    off.queued.shift()!.fn();
    await settle();
    expect(off.fetch).toHaveBeenCalledTimes(1);
  });

  it("waits the Retry-After it was given, within 1 to 120 s, else a minute", () => {
    expect(retryDelayMs("10")).toBe(10_000);
    expect(retryDelayMs("60")).toBe(60_000);
    expect(retryDelayMs("3600")).toBe(120_000);
    expect(retryDelayMs(null)).toBe(60_000);
    expect(retryDelayMs("soon")).toBe(60_000);
    expect(retryDelayMs("0")).toBe(60_000);
  });

  it("the charter says counts may undercount on shared networks, and how a spike is read", () => {
    expect(read("CHARTER.md")).toContain(
      'Counts are rate limited per network; large shared networks may undercount; a spike of counts at the daily ceiling is treated as suspect (see "Reading the counts" below: a day whose count equals the ceiling is the signal).',
    );
    expect(read("CHARTER.md")).toContain("Reading the counts:");
  });
});

describe("the Bookplate's Direction line matches the cast sheet printed above it", () => {
  it("a work with a cast sheet is performed from the layout and the curator's sheet; one without, from the layout alone", () => {
    const crito = WORKS.find((w) => w.slug === "crito")!;
    expect(crito.cast).toBeDefined();
    expect(directionSentence(crito)).toBe("Nobody directed this performance. The same fixed rules perform every work, from the layout of the text and the curator's cast sheet.");
    expect(bookplateHtml(crito)).toContain(`<dt>Direction</dt><dd>${directionSentence(crito)}</dd>`);
    expect(bookplateHtml(crito)).not.toContain("layout of the text alone");
    const plain = { ...crito, cast: undefined };
    expect(directionSentence(plain)).toBe("Nobody directed this performance. The same fixed rules perform every work, from the layout of the text alone.");
    for (const w of WORKS) expect(bookplateHtml(w)).toContain(`<dt>Direction</dt><dd>${directionSentence(w)}</dd>`);
  });
});

describe("the render meter is named for what it measures", () => {
  it("'Getting the voice ready' while the voice downloads, 'Lines made' once it is making lines", () => {
    expect(html).toMatch(/<progress id="render-meter"[^>]*aria-label="Getting the voice ready"/);
    expect(METER_WARMING).toBe("Getting the voice ready");
    expect(METER_MAKING).toBe("Lines made");
    // Reset on every new broadcast, switched on "ready", together with the meter's new max.
    expect(main).toMatch(/meter\.removeAttribute\("value"\);\s*\/\/[^\n]*\n\s*meter\.setAttribute\("aria-label", METER_WARMING\);/);
    expect(main).toMatch(/meter\.max = cues\.length;\s*meter\.value = 0;\s*meter\.setAttribute\("aria-label", METER_MAKING\);/);
  });
});

describe("the Seal switch says where the setting lives", () => {
  it("in this browser, not on this device: an installed Dial or another browser has its own switch", () => {
    expect(html).toContain("The setting stays in this browser. An installed Dial, or another browser, has its own switch.");
    expect(html).not.toContain("The setting stays on this device.");
    // It is local storage, which is per browser (and per installed app on iPhone and iPad).
    expect(read("web/src/telemetry.ts")).toMatch(/localStorage/);
  });
});

describe("npm audit's sharp findings are an accepted risk because sharp never ships (docs/DECISIONS.md)", () => {
  it("the page's bundles carry only the bundler's empty stub for sharp, and the decision is recorded with its re-check", () => {
    const assets = path.join(root, "dist", "assets");
    const files = readdirSync(assets).filter((f) => f.endsWith(".js"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const js = readFileSync(path.join(assets, f), "utf8");
      // Every mention of sharp is the "(ignored)" stub or the import that resolves to it; no libvips code.
      expect(js, f).not.toMatch(/libvips|sharp\.node|sharp-[a-z0-9]+-[a-z0-9]+/i);
      if (js.includes("sharp")) expect(js, f).toContain("sharp (ignored)");
    }
    const decisions = read("docs/DECISIONS.md");
    expect(decisions).toMatch(/## 2026-09-27: npm audit's sharp findings are an accepted risk/);
    expect(decisions).toContain("re-checked by 2026-10-11");
  });
});

describe("the model is stitched in one buffer, not three copies (pre-Proof audit, performance)", () => {
  const repo = "onnx-community/Kokoro-82M-v1.0-ONNX";
  const parts = ["model_quantized.part0", "model_quantized.part1", "model_quantized.part2"];
  const bytes = parts.map((_, i) => new Uint8Array(1000 + i * 37).map((_, j) => (i * 31 + j) & 255));
  const whole = Buffer.concat(bytes.map((b) => Buffer.from(b)));
  const manifest = (over: object = {}) => ({
    repo,
    parts,
    sha256: createHash("sha256").update(whole).digest("hex"),
    sizes: Object.fromEntries(parts.map((p, i) => [partPath({ repo }, p), bytes[i]!.byteLength])),
    ...over,
  });
  /** Serves each part in small chunks, as a network would. */
  const serve = (override?: (i: number) => Uint8Array) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const i = parts.findIndex((p) => url === partPath({ repo }, p));
        if (i < 0) return new Response(null, { status: 404 });
        const body = override ? override(i) : bytes[i]!;
        return new Response(
          new ReadableStream({
            start(c) {
              for (let at = 0; at < body.byteLength; at += 100) c.enqueue(body.slice(at, at + 100));
              c.close();
            },
          }),
        );
      }),
    );
  afterEach(() => vi.unstubAllGlobals());

  it("joins the parts in order, counts every byte as it arrives, and checks the whole against its pin", async () => {
    serve();
    let counted = 0;
    const res = await stitchModel(manifest(), (n) => (counted += n));
    expect(Buffer.from(await res.arrayBuffer()).equals(whole)).toBe(true);
    expect(counted).toBe(whole.byteLength);
    expect(res.headers.get("content-length")).toBe(String(whole.byteLength));
  });

  it("refuses a model that fails its pin, a part longer than the manifest says, and a manifest that does not size the parts", async () => {
    serve();
    await expect(stitchModel(manifest({ sha256: "0".repeat(64) }), () => undefined)).rejects.toThrow(/did not match its pin/);
    serve((i) => (i === 1 ? new Uint8Array(5000) : bytes[i]!));
    await expect(stitchModel(manifest(), () => undefined)).rejects.toThrow(/did not match its pin/);
    serve();
    await expect(stitchModel(manifest({ sizes: {} }), () => undefined)).rejects.toThrow(/does not size/);
  });

  it("reads each part straight into the one buffer: no list of parts, no joined copy", async () => {
    const into = new Uint8Array(10);
    const n = await readInto(new Response(new Uint8Array([1, 2, 3])), into, 4, () => undefined);
    expect(n).toBe(3);
    expect([...into]).toEqual([0, 0, 0, 0, 1, 2, 3, 0, 0, 0]);
    await expect(readInto(new Response(new Uint8Array(8)), into, 4, () => undefined)).rejects.toThrow(/did not match its pin/);
    const src = read("web/src/voice-files.ts");
    const stitch = src.slice(src.indexOf("export async function stitchModel"));
    expect(stitch).toContain("const whole = new Uint8Array(total);");
    expect(stitch).not.toMatch(/buffers\.push|blob\.arrayBuffer\(\)|readCounted/);
  });
});

describe("the tokenizer and config are pinned like the model (T11, L4)", () => {
  const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");
  const repo = "onnx-community/Kokoro-82M-v1.0-ONNX";
  const key = `/voice/models/${repo}/tokenizer.json`;
  const good = new TextEncoder().encode('{"model":"kokoro"}');
  const pins = { files: { [key]: sha(good) } };
  const serve = (body: Uint8Array) => {
    const f = vi.fn(async (url: string) => (url === key ? new Response(body) : new Response(null, { status: 404 })));
    vi.stubGlobal("fetch", f);
    return f;
  };
  /** A one-entry Cache Storage stand-in. */
  const fakeCache = (body?: Uint8Array) => {
    let held = body;
    return {
      match: vi.fn(async (k: string) => (k === key && held ? new Response(held) : undefined)),
      delete: vi.fn(async () => {
        const had = !!held;
        held = undefined;
        return had;
      }),
      get held() {
        return held;
      },
    };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("the voice manifest pins tokenizer.json, tokenizer_config.json and config.json by served path, with fetch-voice's own pins", async () => {
    const { MODEL_FILES, REPO, STAGED_DIRS, modelFilePins } = await import("../scripts/fetch-voice.mjs");
    const want = modelFilePins();
    expect(Object.keys(want).sort()).toEqual(["config.json", "tokenizer.json", "tokenizer_config.json"].map((f) => `/voice/models/${REPO}/${f}`));
    for (const [p, pin] of Object.entries(want)) expect(pin).toBe(MODEL_FILES[p.slice(`/voice/models/${REPO}/`.length)]);
    const manifest = JSON.parse(readFileSync(path.join(STAGED_DIRS.voice, "manifest.json"), "utf8")) as { files: Record<string, string> };
    expect(manifest.files).toEqual(want);
    // The staged bytes are the pinned ones.
    for (const [p, pin] of Object.entries(manifest.files)) {
      expect(sha(readFileSync(path.join(STAGED_DIRS.voice, p.slice("/voice/".length)))), p).toBe(pin);
    }
  });

  it("on fetch: a file that matches its pin is used, one that does not is refused, and an unpinned one is never fetched", async () => {
    serve(good);
    let counted = 0;
    const buf = await fetchPinnedFile(pins, key, (n) => (counted += n));
    expect(Buffer.from(buf).equals(Buffer.from(good))).toBe(true);
    expect(counted).toBe(good.byteLength);
    serve(new TextEncoder().encode('{"model":"swapped"}'));
    await expect(fetchPinnedFile(pins, key, () => undefined)).rejects.toThrow(/did not match its pin/);
    const f = serve(good);
    await expect(fetchPinnedFile({ files: {} }, key, () => undefined)).rejects.toThrow(/is not pinned/);
    await expect(fetchPinnedFile({}, key, () => undefined)).rejects.toThrow(/is not pinned/);
    expect(f).not.toHaveBeenCalled();
    expect(modelFilePin({ files: { [key]: "x" } }, "/voice/models/other.json")).toBeUndefined();
  });

  it("on read: a cached copy is used only while it matches its pin, else it is deleted and fetched again", async () => {
    const ok = fakeCache(good);
    expect(Buffer.from((await cachedPinnedFile(ok, pins, key))!).equals(Buffer.from(good))).toBe(true);
    expect(ok.delete).not.toHaveBeenCalled();
    const bad = fakeCache(new TextEncoder().encode("tampered"));
    expect(await cachedPinnedFile(bad, pins, key)).toBeUndefined();
    expect(bad.delete).toHaveBeenCalledWith(key);
    expect(bad.held).toBeUndefined();
    const unpinned = fakeCache(good);
    expect(await cachedPinnedFile(unpinned, { files: {} }, key)).toBeUndefined();
    expect(unpinned.delete).toHaveBeenCalled();
    expect(await cachedPinnedFile(fakeCache(), pins, key)).toBeUndefined();
  });

  it("the pinned cache never throws and never answers undefined for a model file: a miss or mismatch is a body that fails", async () => {
    serve(new TextEncoder().encode("tampered on the wire"));
    const kept: string[] = [];
    const keep = async (k: string) => void kept.push(k);
    const m = { ...pins, repo, model: "onnx/model_quantized.onnx" };
    const pc = pinnedModelCache(fakeCache(new TextEncoder().encode("tampered in the cache")), m, () => undefined, keep, async () => {
      throw new Error("voice: the model did not match its pin");
    });
    const tok = await pc.match(key);
    expect(tok).toBeInstanceOf(Response);
    await expect(tok!.arrayBuffer()).rejects.toThrow(/did not match its pin/);
    const unpinned = await pc.match(`/voice/models/${repo}/generation_config.json`);
    expect(unpinned).toBeInstanceOf(Response);
    await expect(unpinned!.arrayBuffer()).rejects.toThrow(/is not pinned/);
    const model = await pc.match(`/voice/models/${repo}/onnx/model_quantized.onnx`);
    await expect(model!.arrayBuffer()).rejects.toThrow(/did not match its pin/);
    expect(await pc.match("https://huggingface.co/x")).toBeUndefined();
    // put(): only bytes that match their pin are kept.
    await pc.put(key, new Response(new TextEncoder().encode("tampered")));
    await pc.put(`/voice/models/${repo}/generation_config.json`, new Response(good));
    await pc.put(`/voice/models/${repo}/onnx/model_quantized.onnx`, new Response(good));
    expect(kept).toEqual([]);
    expect(await putPinnedFile(pins, key, new Response(good), keep)).toBe(true);
    expect(kept).toEqual([key]);
  });

  it("the three files are checked before the runtime is built: a bad copy is replaced from this origin, and a bad origin aborts", async () => {
    const files = Object.fromEntries(["config.json", "tokenizer.json", "tokenizer_config.json"].map((f) => [`/voice/models/${repo}/${f}`, new TextEncoder().encode(`{"f":"${f}"}`)]));
    const m = { repo, files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, sha(b)])) };
    const store = new Map<string, Uint8Array>(Object.entries(files));
    store.set(key, new TextEncoder().encode("tampered"));
    const cache = {
      match: async (k: string) => (store.has(k) ? new Response(store.get(k)) : undefined),
      delete: async (k: string) => store.delete(k),
    };
    const keep = async (k: string, r: Response) => void store.set(k, new Uint8Array(await r.arrayBuffer()));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (files[url] ? new Response(files[url]) : new Response(null, { status: 404 }))));
    await preparePinnedFiles(cache, m, () => undefined, keep);
    expect(Buffer.from(store.get(key)!).equals(Buffer.from(files[key]!))).toBe(true);
    // A tampered copy and an origin that serves the same: the load aborts.
    store.set(key, new TextEncoder().encode("tampered"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new TextEncoder().encode("tampered"))));
    await expect(preparePinnedFiles(cache, m, () => undefined, keep)).rejects.toThrow(/did not match its pin/);
    // Offline with a tampered copy: aborts too, never uses it.
    store.set(key, new TextEncoder().encode("tampered"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(preparePinnedFiles(cache, m, () => undefined, keep)).rejects.toThrow(/404/);
    // A manifest without the pins (an older build's) cannot load.
    await expect(preparePinnedFiles(cache, { repo, files: {} }, () => undefined, keep)).rejects.toThrow(/is not pinned/);
  });

  it("tampered bytes from the cache make transformers.js's own tokenizer load reject, never fall through to an unchecked fetch", async () => {
    const { env, AutoTokenizer } = await import("@huggingface/transformers");
    const { REPO, STAGED_DIRS, modelFilePins } = await import("../scripts/fetch-voice.mjs");
    const before = { ...env, customCache: env.customCache };
    const real = (p: string) => new Uint8Array(readFileSync(path.join(STAGED_DIRS.voice, p.slice("/voice/".length))));
    const m = { repo: REPO, model: "onnx/model_quantized.onnx", files: modelFilePins() as Record<string, string> };
    const tokKey = `/voice/models/${REPO}/tokenizer.json`;
    const store = new Map<string, Uint8Array>(Object.keys(m.files).map((k) => [k, real(k)]));
    const cache = {
      match: async (k: string) => (store.has(k) ? new Response(store.get(k)) : undefined),
      delete: async (k: string) => store.delete(k),
    };
    const keep = async (k: string, r: Response) => void store.set(k, new Uint8Array(await r.arrayBuffer()));
    Object.assign(env, { allowRemoteModels: false, allowLocalModels: true, localModelPath: "/voice/models/", useBrowserCache: false, useFSCache: false, useCustomCache: true });
    env.customCache = pinnedModelCache(cache, m, () => undefined, keep, async () => new Response(null, { status: 404 }));
    try {
      // Honest bytes load.
      const tok = await AutoTokenizer.from_pretrained(REPO);
      expect(tok).toBeTruthy();
      // One changed byte in the cached tokenizer, and an origin serving the same: the load rejects with the pin error.
      const bad = real(tokKey);
      bad[bad.length - 2] = bad[bad.length - 2] === 32 ? 10 : 32;
      store.set(tokKey, bad);
      vi.stubGlobal("fetch", vi.fn(async () => new Response(bad)));
      await expect(AutoTokenizer.from_pretrained(REPO)).rejects.toThrow(/did not match its pin/);
    } finally {
      Object.assign(env, before);
    }
  });

  it("the loader and Save for offline both go through the pinned helpers, never a bare fetch of a model file", () => {
    const voice = read("web/src/voice.ts");
    expect(voice).toContain("env.customCache = pinnedModelCache(cache, manifest, count, keepModelFile, () => stitchModel(manifest, count));");
    expect(voice).toContain("await preparePinnedFiles(cache, manifest, count, keepModelFile);");
    // The check comes before the runtime is built.
    expect(voice.indexOf("await preparePinnedFiles(")).toBeLessThan(voice.indexOf("KokoroTTS.from_pretrained("));
    expect(voice).not.toMatch(/fetch\(`\/voice\/models\//);
    const store = read("web/src/offline/store.ts");
    expect(store).toContain("await put(cache, p, new Response(await fetchPinnedFile(m, p, count, signal)));");
    expect(store).not.toMatch(/fetch\(`\/voice\/models\//);
  });
});
