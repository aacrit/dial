// Law 2: the words are the author's. Every cue is a byte-exact slice of the
// source, the cues rebuild it exactly, and the voice is given the same words
// with only whitespace folded. Law 3: the cut is deterministic.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_CUE_CHARS, PAUSE_MS, rebuild, segment } from "../web/src/engine/segment";
import { assemble, encodeWav } from "../web/src/engine/wav";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cave = readFileSync(path.join(root, "web/public/works/cave.txt"), "utf8");
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

describe("the Cave's source", () => {
  it("is Gutenberg #1497's Book VII from 514a to 521b, byte for byte (CRLF folded to LF)", () => {
    // Lines 18773 to 19111 of pg1497.txt (updated 2026-03-31), line endings as LF.
    expect(sha(cave)).toBe("e4a5c0abf23d93b3ee3470cd34ab8cb68de2940c49aff4e62bf9e55d6dbceb28");
    expect(cave.startsWith("And now, I said, let me show in a figure")).toBe(true);
    expect(cave.trimEnd().endsWith("They are the men, and I will choose them, he replied.")).toBe(true);
  });
});

describe("Law 2: segment() never changes a word", () => {
  const cues = segment(cave);

  it("every cue's text is the exact slice it claims", () => {
    for (const c of cues) expect(c.text).toBe(cave.slice(c.start, c.end));
  });

  it("the cues and the whitespace between them rebuild the source exactly", () => {
    expect(sha(rebuild(cave, cues))).toBe(sha(cave));
  });

  it("the voice gets the same words: only whitespace differs", () => {
    for (const c of cues) expect(c.spoken.replace(/\s/g, "")).toBe(c.text.replace(/\s/g, ""));
  });

  it("every cue fits the voice's window, or had no clause mark to break at", () => {
    for (const c of cues) if (c.text.length > MAX_CUE_CHARS) expect(c.text).not.toMatch(/[;:,—]/);
  });

  it("rebuild() refuses cues that drop text", () => {
    expect(() => rebuild(cave, cues.slice(1))).toThrow(/dropped/);
  });
});

describe("Law 3: the cut is structural and deterministic", () => {
  it("the same text gives the same cues", () => {
    expect(JSON.stringify(segment(cave))).toBe(JSON.stringify(segment(cave)));
  });

  it("paragraphs end in the paragraph pause and the work ends in 4.5 s of silence", () => {
    const cues = segment("One. Two?\n\nThree!");
    expect(cues.map((c) => [c.text, c.rule])).toEqual([
      ["One.", "sentence"],
      ["Two?", "paragraph-end"],
      ["Three!", "work-end"],
    ]);
    expect(cues.at(-1)!.pauseAfterMs).toBe(4500);
    expect(PAUSE_MS["paragraph-end"]).toBe(600);
  });
});

describe("the download", () => {
  it("is a valid 16-bit mono WAV with the silences in it", () => {
    const pcm = assemble([{ audio: new Float32Array([0.5, -0.5]), pauseAfterMs: 1000 }], 10);
    expect(pcm.length).toBe(12);
    const wav = encodeWav(pcm, 10);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(40, true)).toBe(24);
    expect(v.getInt16(44, true)).toBe(16383);
    expect(v.getInt16(46, true)).toBe(-0x4000);
    expect(v.getInt16(48, true)).toBe(0);
  });
});
