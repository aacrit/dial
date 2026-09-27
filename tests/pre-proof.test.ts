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
import { partPath, readInto, stitchModel } from "../web/src/voice-files";
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
