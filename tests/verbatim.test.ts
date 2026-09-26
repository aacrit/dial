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
import { PLUS_MARKS, UPSTREAM_SHA256, checkUpstream, dropNotes, extractWork, sliceLines } from "../scripts/extract-work.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = (slug: string) => readFileSync(path.join(root, `web/public/works/${slug}.txt`), "utf8");
const cave = work("cave");
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

// Each file is made by scripts/extract-work.mjs from the Gutenberg plain
// text (https://www.gutenberg.org/cache/epub/<n>/pg<n>.txt, fetched
// 2026-09-26), whose SHA-256 the script checks before it cuts:
//   pg1497.txt  917c1cb469e1a8eba6083808764d7131da8d79140b575b4214c9d02a73ec4528
//   pg1657.txt  8f7e8c4cdb7ad512603f9359d5e7ce5c3aa281f7c83a07ac08c07bad90f9faae
//   pg15877.txt 6584df7e90d6035eece30d8028527290bf2508076963ee0376cb41db9cf88d5b
// CRLF folded to LF, only the performed lines kept.
describe("the works' sources, byte for byte", () => {
  it("the Cave is Gutenberg #1497's Book VII from 514a to 521b", () => {
    // Lines 18773 to 19111 of pg1497.txt (updated 2026-03-31), line endings as LF:
    // `node scripts/extract-work.mjs 1497 pg1497.txt 18773 19111`.
    expect(sha(cave)).toBe("e4a5c0abf23d93b3ee3470cd34ab8cb68de2940c49aff4e62bf9e55d6dbceb28");
    expect(cave.startsWith("And now, I said, let me show in a figure")).toBe(true);
    expect(cave.trimEnd().endsWith("They are the men, and I will choose them, he replied.")).toBe(true);
  });

  it("Crito is Gutenberg #1657 from the first line of the dialogue to its last", () => {
    // Lines 172 to 712 of pg1657.txt (most recently updated 2015-04-03), line
    // endings as LF: `node scripts/extract-work.mjs 1657 pg1657.txt 172 712`.
    // Before line 172: the header, Jowett's introduction, the persons and the scene.
    const crito = work("crito");
    expect(sha(crito)).toBe("4bfe860a921312773e382ef567f481210e38cf52303bfb3c64dd0fda0c8d6386");
    expect(crito.startsWith("SOCRATES:  Why have you come at this hour, Crito? it must be quite early.")).toBe(true);
    expect(crito.trimEnd().endsWith("Leave me then, Crito, to fulfil the will of God, and to follow\nwhither he leads.")).toBe(true);
  });

  it("Meditations Book II is Gutenberg #15877 (George Long), with his footnotes and + marks left out", () => {
    // Lines 2496 to 2720 of pg15877.txt (most recently updated 2020-12-14),
    // line endings as LF, then Long's apparatus removed (CLAUDE.md, Law 2):
    // `node scripts/extract-work.mjs 15877 pg15877.txt 2496 2720 --drop-notes`.
    // Line 2714 is "This in Carnuntum.[A]"; 2716 to 2720 are its note.
    // (Gutenberg #2680 is Meric Casaubon's translation, not Long's.)
    const med = work("meditations");
    expect(sha(med)).toBe("0d9a47eac4010994e70addc21061101e0667c057e616d2a366cef86b4b6e9484");
    expect(med.startsWith("Begin the morning by saying to thyself, I shall meet with the busybody,")).toBe(true);
    expect(med.trimEnd().endsWith("This in Carnuntum.")).toBe(true);
    // The words Long supplied in brackets stay; footnote markers, notes and + marks do not.
    expect(med).toContain("not [only] of the same blood or seed");
    expect(med).not.toMatch(/\[[A-Z]\]|\+|\[Greek:|Xenophon/);
  });
});

describe("scripts/extract-work.mjs removes only Long's apparatus", () => {
  it("pins the upstream files and refuses any other bytes", () => {
    expect(UPSTREAM_SHA256).toEqual({
      1497: "917c1cb469e1a8eba6083808764d7131da8d79140b575b4214c9d02a73ec4528",
      1657: "8f7e8c4cdb7ad512603f9359d5e7ce5c3aa281f7c83a07ac08c07bad90f9faae",
      15877: "6584df7e90d6035eece30d8028527290bf2508076963ee0376cb41db9cf88d5b",
    });
    expect(() => checkUpstream(15877, Buffer.from("a different revision"))).toThrow(/pinned 6584df7e/);
    expect(() => checkUpstream(2680, Buffer.from("x"))).toThrow(/no upstream pin/);
  });

  it("Law 2 clause: the extraction refuses when the upstream file does not match its pinned SHA-256", () => {
    const tampered = Buffer.from("SOCRATES:  Why have you come at this hour, Crito?\r\n");
    expect(() => extractWork(tampered, 1657, 1, 1)).toThrow(/pg1657\.txt is sha256 [0-9a-f]{64}, pinned 8f7e8c4c/);
    expect(() => extractWork(tampered, 15877, 1, 1, true)).toThrow(/pinned 6584df7e/);
  });

  it("slices lines, folds CRLF and ends in one newline", () => {
    expect(sliceLines("a\r\nb\r\nc\r\nd\r\n", 2, 3)).toBe("b\nc\n");
  });

  it("drops indented note blocks, their markers and + marks, and nothing else", () => {
    const src =
      "teeth.[A] To act,\nthen.\n\n    [A] Xenophon, Mem.\n\n6. Do wrong[A] to thyself,\nsufficient.+ But the same;+[B] and [only] this.\n\n    [A] Perhaps.\n    [Greek: x]\n\n    [B] Gataker.\n\nThis in Carnuntum.[A]\n\n    [A] A town of Pannonia.\n";
    expect(dropNotes(src, 2)).toBe("teeth. To act,\nthen.\n\n6. Do wrong to thyself,\nsufficient. But the same; and [only] this.\n\nThis in Carnuntum.\n");
  });

  it("removes + marks only for the eBooks listed, and only the pinned number of them", () => {
    // Long's preface to #15877: "I have placed in some passages a +, which indicates
    // corruption in the text or great uncertainty in the meaning." Book II has three:
    // "sufficient.+", "disposed+" and "the same;+".
    expect(PLUS_MARKS).toEqual({ 15877: 3 });
    const src = "sufficient.+ But 2 + 2.\n";
    expect(dropNotes(src)).toBe(src); // not listed: nothing removed
    expect(dropNotes(src, 1)).toBe("sufficient. But 2 + 2.\n"); // a free-standing + is never a mark
    expect(() => dropNotes(src, 3)).toThrow(/1 \+ marks in the text, expected 3/);
  });

  it("Law 2 clause: refuses when markers and notes do not match one for one, so a real bracketed capital never vanishes", () => {
    expect(() => dropNotes("And [I] said so.[A]\n\n    [A] A note.\n")).toThrow(/2 note markers in the text but 1 notes/);
    expect(() => dropNotes("This in Carnuntum.[A]\n")).toThrow(/1 note markers in the text but 0 notes/);
  });
});

for (const slug of ["cave", "crito", "meditations"]) {
  describe(`Law 2 (${slug}): segment() never changes a word`, () => {
    const source = work(slug);
    const cues = segment(source);

    it("every cue's text is the exact slice it claims", () => {
      for (const c of cues) expect(c.text).toBe(source.slice(c.start, c.end));
    });

    it("the cues and the whitespace between them rebuild the source exactly", () => {
      expect(sha(rebuild(source, cues))).toBe(sha(source));
    });

    it("the voice gets the same words: only whitespace differs", () => {
      for (const c of cues) expect(c.spoken.replace(/\s/g, "")).toBe(c.text.replace(/\s/g, ""));
    });

    it("every cue fits the voice's window, or had no clause mark to break at", () => {
      for (const c of cues) if (c.text.length > MAX_CUE_CHARS) expect(c.text).not.toMatch(/[;:,—]/);
    });

    it("rebuild() refuses cues that drop text", () => {
      expect(() => rebuild(source, cues.slice(1))).toThrow(/dropped/);
    });
  });
}

describe("Law 2: the Cave's cut is unchanged", () => {
  const cues = segment(cave);

  it("is 118 lines, the count the spec quotes", () => {
    expect(cues.length).toBe(118);
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
