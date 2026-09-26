// T1: the Spark page follows the G2-approved colour and copy rules
// (design/spec.md 1.1 and 6). Tally is a lamp, never a text ground; errors
// earn no hue; the first voice download is stated from the staged bytes;
// the em-dash lint never reads an author's verbatim text.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { STAGED_DIRS, stage } from "../scripts/fetch-voice.mjs";
import { checkEmDashLine, isVerbatimPath, shouldScan } from "../scripts/lint-design.mjs";
import { walk } from "../scripts/lib/walk.mjs";
import { aboutMegabytes, warmingLine } from "../web/src/download-size";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(root, "web/src/style.css"), "utf8");
const main = readFileSync(path.join(root, "web/src/main.ts"), "utf8");

/** Every rule in the stylesheet as [selector, declarations]. The Spark CSS has no nesting. */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (m) => [m[1]!.trim(), m[2]!] as const,
);
const decl = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

describe("tally is a lamp only", () => {
  it("the on-air button has a cream label on no tally ground", () => {
    const onAir = rules.filter(([sel]) => /data-on-air/.test(sel) && /#tune-in(?!::)/.test(sel) && !/::/.test(sel));
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

describe("true copy: the first voice download", () => {
  beforeAll(async () => {
    // The gate builds (and so stages) before tests; stage here if run alone.
    if (!existsSync(path.join(STAGED_DIRS.voice, "manifest.json"))) await stage();
  }, 120_000);

  it("the manifest's totalBytes equals the sum of the staged files (manifest excluded)", () => {
    const manifestPath = path.join(STAGED_DIRS.voice, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { totalBytes: number; parts: string[] };
    let sum = 0;
    const kinds = { part: 0, voice: 0, mjs: 0, wasm: 0 };
    for (const dir of [STAGED_DIRS.voice, STAGED_DIRS.ort]) {
      for (const file of walk(dir)) {
        if (path.resolve(file) === path.resolve(manifestPath)) continue;
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

  it("states the size rounded from the total", () => {
    expect(aboutMegabytes(114_527_513)).toBe("about 115 MB");
    expect(aboutMegabytes(89_600_000)).toBe("about 90 MB");
    expect(warmingLine(114_527_513)).toBe("Warming the voice. It downloads once (about 115 MB) and then stays on this device.");
    expect(warmingLine(114_527_513)).not.toMatch(/—|!/);
  });

  it("the page computes the size and the meter's max from the manifest total, never a hard-coded guess", () => {
    expect(main).not.toMatch(/\d+\s*MB/);
    expect(main).not.toMatch(/MODEL_BYTES/);
    expect(main).toMatch(/meter\.max = msg\.total/);
    expect(main).toMatch(/warmingLine\(msg\.total\)/);
  });
});

describe("the em-dash lint never reads verbatim author text", () => {
  it("web/public/works/ is exempt, whatever the extension", () => {
    for (const p of ["web/public/works/cave.txt", "web/public/works/cave.html", "web/public/works/crito/notes.ts"]) {
      expect(isVerbatimPath(p)).toBe(true);
      expect(shouldScan(p)).toBe(false);
      expect(checkEmDashLine(p, "unenlightened:—Behold!")).toBeNull();
    }
  });

  it("Dial's own UI copy is still checked", () => {
    for (const p of ["web/index.html", "web/privacy.html", "web/src/main.ts"]) {
      expect(isVerbatimPath(p)).toBe(false);
      expect(shouldScan(p)).toBe(true);
      expect(checkEmDashLine(p, "Tune in — now")).toMatch(/em dash/);
    }
    // A folder named like works, but not the verbatim one, gets no pass.
    expect(shouldScan("web/public/works-list.html")).toBe(true);
    expect(checkEmDashLine("web/public/works-list.html", "a — b")).toMatch(/em dash/);
  });
});
