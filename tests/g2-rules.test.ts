// T1: the Spark page follows the G2-approved colour and copy rules
// (design/spec.md 1.1 and 6). Tally is a lamp, never a text ground; errors
// earn no hue; the first voice download is stated from the staged bytes and
// the runtime is pinned; the em-dash lint never reads an author's verbatim
// text.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ORT_FILES, ORT_WASM, STAGED_DIRS, stage } from "../scripts/fetch-voice.mjs";
import { checkColorLine, checkEmDashLine, isVerbatimPath, shouldScan } from "../scripts/lint-design.mjs";
import { walk } from "../scripts/lib/walk.mjs";
import { aboutMegabytes, isStatableTotal, warmingLine } from "../web/src/download-size";
import { runtimeCacheKey, staleVoiceCaches, voiceCacheName } from "../web/src/voice-cache";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const css = read("web/src/style.css");
const main = read("web/src/main.ts");
const voiceSrc = read("web/src/voice.ts");
const indexHtml = read("web/index.html");
const privacyHtml = read("web/privacy.html");
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const manifestPath = () => path.join(STAGED_DIRS.voice, "manifest.json");

/** Every rule in the stylesheet as [selector, declarations]. The Spark CSS has no nesting. */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (m) => [m[1]!.trim(), m[2]!] as const,
);
const decl = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

describe("tally is a lamp only", () => {
  it("the on-air button has a cream label on no tally ground", () => {
    const onAir = rules.filter(([sel]) => /data-on-air/.test(sel) && /#tune-in/.test(sel) && !/::/.test(sel));
    expect(onAir.length).toBeGreaterThan(0);
    for (const [, body] of onAir) {
      expect(decl(body, "background") ?? "").not.toContain("--color-tally");
      expect(decl(body, "background-color") ?? "").not.toContain("--color-tally");
      expect(decl(body, "color")).toBe("var(--color-cream)");
    }
  });

  it("while on air the button lights a small tally lamp beside its label", () => {
    const lamp = rules.find(([sel]) => /data-on-air/.test(sel) && /#tune-in::before/.test(sel));
    expect(lamp).toBeDefined();
    const body = lamp![1];
    expect(decl(body, "background")).toBe("var(--color-tally)");
    expect(decl(body, "content")).toBe('""');
    for (const side of ["width", "height"]) expect(Number.parseFloat(decl(body, side)!)).toBeLessThanOrEqual(12);
  });

  it("tally is never a text colour or a ground for text anywhere in the stylesheet", () => {
    for (const [sel, body] of rules) {
      if (!body.includes("--color-tally")) continue;
      // Only a text-less pseudo-element lamp may carry tally.
      expect(sel, sel).toMatch(/::(before|after)$/);
      expect(decl(body, "content"), sel).toBe('""');
      expect(decl(body, "color") ?? "", sel).not.toContain("--color-tally");
    }
  });
});

describe("errors earn no hue", () => {
  for (const id of ["broadcast-status", "feedback-status"]) {
    it(`#${id}[data-state="error"] is cream prose`, () => {
      const rule = rules.find(([sel]) => sel === `#${id}[data-state="error"]`);
      expect(rule).toBeDefined();
      expect(decl(rule![1], "color")).toBe("var(--color-cream)");
      expect(rule![1]).not.toContain("--color-tally");
    });
  }
});

describe("the meter never outlives the work", () => {
  it("a hidden meter is not drawn", () => {
    const rule = rules.find(([sel]) => sel === "progress[hidden]");
    expect(rule).toBeDefined();
    expect(decl(rule![1], "display")).toBe("none");
  });

  it("a failure hides the meter and marks the status as an error", () => {
    const stopped = /const stopped = \(message: string\) => \{([\s\S]*?)\n {4}\};/.exec(main)?.[1];
    expect(stopped).toBeDefined();
    expect(stopped).toContain("meter.hidden = true");
    expect(stopped).toContain('status.dataset.state = "error"');
    // The worker's error message (a failed manifest fetch or parse lands
    // there) and a worker that fails outright both end in stopped().
    expect(main).toMatch(/\} else \{\s*stopped\(msg\.message\);/);
    expect(main).toMatch(/worker\.onerror = [\s\S]*?stopped\(/);
  });

  it("the status line's counts and sizes use tabular figures", () => {
    const rule = rules.find(([sel]) => sel === "#broadcast-status");
    expect(rule).toBeDefined();
    expect(decl(rule![1], "font-variant-numeric")).toBe("tabular-nums");
  });
});

describe("true copy: the first voice download", () => {
  beforeAll(async () => {
    // The gate builds (and so stages) before tests; stage here if run alone.
    if (!existsSync(manifestPath())) await stage();
  }, 120_000);

  it("the manifest's totalBytes equals the sum of the staged files (manifest excluded)", () => {
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as { totalBytes: number; parts: string[] };
    let sum = 0;
    const kinds = { part: 0, voice: 0, mjs: 0, wasm: 0 };
    for (const dir of [STAGED_DIRS.voice, STAGED_DIRS.ort]) {
      for (const file of walk(dir)) {
        if (path.resolve(file) === path.resolve(manifestPath())) continue;
        sum += statSync(file).size;
        if (/\.part\d+$/.test(file)) kinds.part++;
        if (file.endsWith(".bin")) kinds.voice++;
        if (file.endsWith(".mjs")) kinds.mjs++;
        if (file.endsWith(".wasm")) kinds.wasm++;
      }
    }
    // Everything the tab downloads for the voice is in the sum.
    expect(kinds.part).toBe(manifest.parts.length);
    expect(kinds.voice).toBe(1);
    expect(kinds.mjs).toBe(1);
    expect(kinds.wasm).toBe(1);
    expect(manifest.totalBytes).toBe(sum);
  });

  it("the runtime is pinned: the manifest carries the staged .wasm's sha256", () => {
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as { runtime: string; runtimeSha256: string };
    expect(manifest.runtime).toBe(ORT_WASM);
    expect(manifest.runtimeSha256).toBe(ORT_FILES[ORT_WASM]);
    for (const [file, pin] of Object.entries(ORT_FILES)) {
      expect(sha256(readFileSync(path.join(STAGED_DIRS.ort, file))), file).toBe(pin);
    }
  });

  it("a runtime pin mismatch fails staging before anything on disk changes", async () => {
    const before = readFileSync(manifestPath(), "utf8");
    const wrong = { ...ORT_FILES, [ORT_WASM]: "0".repeat(64) };
    await expect(stage({ ortPins: wrong })).rejects.toThrow(/sha256 \w+, pinned 0{64}/);
    expect(readFileSync(manifestPath(), "utf8")).toBe(before);
  });

  it("states the size rounded from the total", () => {
    expect(aboutMegabytes(114_527_513)).toBe("about 115 MB");
    expect(aboutMegabytes(89_600_000)).toBe("about 90 MB");
    expect(warmingLine(114_527_513, false)).toBe("Warming the voice. It downloads once (about 115 MB) and is kept on this device.");
    expect(warmingLine(114_527_513, false)).not.toMatch(/—|!/);
  });

  it("claims no download on a repeat visit, and no size without a usable total", () => {
    expect(warmingLine(114_527_513, true)).toBe("Warming the voice from this device.");
    for (const bad of [undefined, null, Number.NaN, Infinity, 0, -5, "115"]) {
      expect(isStatableTotal(bad)).toBe(false);
      expect(warmingLine(bad, false)).toBe("Warming the voice.");
    }
    expect(isStatableTotal(114_527_513)).toBe(true);
  });

  it("the page computes the size and the meter's max from the manifest total, never a hard-coded guess", () => {
    expect(main).not.toMatch(/\d+\s*MB/);
    expect(main).not.toMatch(/MODEL_BYTES/);
    expect(main).toMatch(/if \(isStatableTotal\(msg\.total\)\) \{\s*meter\.max = msg\.total;/);
    expect(main).toMatch(/warmingLine\(msg\.total, msg\.fromDevice\)/);
  });

  it("the page makes no offline claim before offline exists", () => {
    for (const [name, src] of [["index.html", indexHtml], ["privacy.html", privacyHtml], ["main.ts", main]] as const) {
      expect(src, name).not.toMatch(/offline/i);
    }
  });
});

describe("the voice cache is keyed to its pins", () => {
  const pins = { revision: "1939ad2a", runtime: ORT_WASM, runtimeSha256: ORT_FILES[ORT_WASM] };

  it("the runtime's cache key and the cache name carry the runtime sha", () => {
    expect(runtimeCacheKey(pins)).toContain(pins.runtimeSha256);
    expect(runtimeCacheKey(pins)).toMatch(/^\/ort\//);
    expect(voiceCacheName(pins)).toContain(pins.runtimeSha256.slice(0, 16));
    expect(voiceCacheName({ ...pins, runtimeSha256: "f".repeat(64) })).not.toBe(voiceCacheName(pins));
  });

  it("every other Dial voice cache is stale; other caches are left alone", () => {
    const current = voiceCacheName(pins);
    expect(staleVoiceCaches(["dial-voice-old", current, "kokoro-voices", "dial-voice-1939ad2a"], current)).toEqual([
      "dial-voice-old",
      "dial-voice-1939ad2a",
    ]);
  });

  it("the loader checks the runtime against its pin on read and on fetch, deletes stale caches, and survives a full quota", () => {
    expect(voiceSrc).toMatch(/if \(hit && \(await sha256Hex\(hit\)\) === m\.runtimeSha256\) return hit;/);
    expect(voiceSrc).toMatch(/if \(\(await sha256Hex\(binary\)\) !== m\.runtimeSha256\) throw/);
    expect(voiceSrc).toMatch(/staleVoiceCaches\(await caches\.keys\(\), cacheName\)\) await caches\.delete/);
    expect(voiceSrc).toMatch(/async function keep[\s\S]*?try \{\s*await cache\.put/);
    expect(voiceSrc).toMatch(/await keep\(cache, key, new Response\(binary/);
  });
});

describe("the em-dash lint never reads verbatim author text", () => {
  it("text files under web/public/works/ are exempt from the em-dash check", () => {
    for (const p of ["web/public/works/cave.txt", "web/public/works/crito/crito.txt"]) {
      expect(isVerbatimPath(p)).toBe(true);
      expect(checkEmDashLine(p, "unenlightened:—Behold!")).toBeNull();
    }
  });

  it("the exemption is the em-dash check on text only: other files there are fully checked, colour everywhere", () => {
    for (const p of ["web/public/works/cave.html", "web/public/works/crito/notes.ts"]) {
      expect(isVerbatimPath(p)).toBe(false);
      expect(shouldScan(p)).toBe(true);
      expect(checkColorLine(p, "color: #ff0000;")).toMatch(/color literal/);
    }
    expect(checkEmDashLine("web/public/works/cave.html", "a — b")).toMatch(/em dash/);
  });

  it("Dial's own UI copy is still checked", () => {
    for (const p of ["web/index.html", "web/privacy.html", "web/src/main.ts"]) {
      expect(isVerbatimPath(p)).toBe(false);
      expect(shouldScan(p)).toBe(true);
      expect(checkEmDashLine(p, "Tune in — now")).toMatch(/em dash/);
    }
    // A folder named like works, but not the verbatim one, gets no pass.
    expect(isVerbatimPath("web/public/works-list.txt")).toBe(false);
    expect(checkEmDashLine("web/public/works-list.html", "a — b")).toMatch(/em dash/);
  });
});
