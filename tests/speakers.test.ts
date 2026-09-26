// T2b: labelled scripts (Law 3 rule 1) and casting without content. Crito's
// speakers are found from the labels alone, each is cast a voice in the
// order they first speak, the labels are never spoken, and the works with
// no labels are exactly as they were.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answerKey } from "../scripts/answer-key.mjs";
import { VOICES } from "../scripts/fetch-voice.mjs";
import { WORKS } from "../web/src/catalogue";
import { NARRATOR_VOICE, PALETTE, VOICE_NAMES, cast, speakerName, voiceCount } from "../web/src/engine/cast";
import { rebuild, segment, speakerLabel } from "../web/src/engine/segment";
import { bookplateHtml, esc, metaHtml, readAlongHtml, readLines, scaleSvg } from "../web/src/render";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const text = (slug: string) => read(`web/public/works/${slug}.txt`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const crito = text("crito");
const cues = segment(crito);
const key = JSON.parse(read("tests/fixtures/crito-turns.json")) as { speaker: string; opens: string }[];

describe("Law 3 rule 1: speaker labels", () => {
  it("finds an ALL-CAPS name and a colon or full stop at a paragraph's start, and nothing else", () => {
    expect(speakerLabel("SOCRATES:  Why have you come")).toEqual({ name: "SOCRATES", length: 11 });
    expect(speakerLabel("CRITO. Yes, certainly.")).toEqual({ name: "CRITO", length: 7 });
    expect(speakerLabel("FIRST CITIZEN: Before we proceed")).toEqual({ name: "FIRST CITIZEN", length: 15 });
    for (const para of ["And now, I said, let me show", "2. Whatever this is", "II. Of the soul", "XIV. Of the soul", "I. Begin", "SOCRATES:", "SOCRATES:   ", "Socrates: Why", "SOCRATES said"]) {
      expect(speakerLabel(para), para).toBeNull();
    }
  });

  it("a labelled turn keeps the label in its text, drops it from what is spoken, and its later lines inherit the speaker", () => {
    const src = "SOCRATES:  Why have you come? It is early.\n\nCRITO. Yes.\n\nIt is.";
    const got = segment(src);
    expect(got.map((c) => [c.text, c.spoken, c.speaker, c.speakerRule])).toEqual([
      ["SOCRATES:  Why have you come?", "Why have you come?", "SOCRATES", "speaker-label"],
      ["It is early.", "It is early.", "SOCRATES", "turn-continues"],
      ["CRITO. Yes.", "Yes.", "CRITO", "speaker-label"],
      ["It is.", "It is.", "CRITO", "turn-continues"],
    ]);
    expect(rebuild(src, got)).toBe(src);
  });

  it("a long turn is never broken at its own label's colon: every part has words to speak", () => {
    const src = `FIRST GENTLEMAN OF VERONA: ${"word, ".repeat(70)}end.`;
    const got = segment(src);
    expect(got.length).toBeGreaterThan(1);
    for (const c of got) expect(c.spoken.length, c.text).toBeGreaterThan(0);
    expect(got[0]!.spoken.startsWith("word,")).toBe(true);
  });
});

describe("Crito: every turn has its speaker", () => {
  it("the answer key is made apart from the engine, and is the one committed", () => {
    expect(answerKey(crito, ["SOCRATES", "CRITO"])).toEqual(key);
    expect(key.length).toBe(95);
  });

  it("the engine finds every labelled turn in the key, in order, with its speaker: 100% agreement", () => {
    const turns = cues.filter((c) => c.speakerRule === "speaker-label");
    expect(turns.map((c) => c.speaker)).toEqual(key.map((t) => t.speaker));
    // The same words open each turn (a short first sentence may end before the key's six words do).
    turns.forEach((c, i) => {
      const got = c.spoken.split(" ");
      const want = key[i]!.opens.split(" ");
      const n = Math.min(got.length, want.length);
      expect(got.slice(0, n), c.text).toEqual(want.slice(0, n));
    });
  });

  it("every cue has a speaker, only SOCRATES and CRITO occur, and they alternate as the labels do", () => {
    expect(cues.every((c) => c.speaker !== undefined)).toBe(true);
    expect([...new Set(cues.map((c) => c.speaker))]).toEqual(["SOCRATES", "CRITO"]);
    // Each unlabelled line continues the turn before it.
    cues.forEach((c, i) => {
      if (c.speakerRule === "turn-continues") expect(c.speaker).toBe(cues[i - 1]!.speaker);
    });
    const runs = cues.map((c) => c.speaker).filter((s, i, all) => i === 0 || s !== all[i - 1]);
    expect(runs.length).toBe(95);
  });

  it("no label is spoken: spoken is the text minus the label, whitespace folded", () => {
    for (const c of cues) {
      expect(c.spoken).not.toMatch(/^(SOCRATES|CRITO)[:.]/);
      const label = c.speakerRule === "speaker-label" ? speakerLabel(c.text)!.length : 0;
      expect(c.spoken).toBe(c.text.slice(label).replace(/\s+/g, " ").trim());
    }
  });

  it("the Laws' speech, which Socrates reports without labels, stays his", () => {
    const laws = cues.find((c) => c.text.startsWith("'Listen, then, Socrates, to us who have brought you up."));
    expect(laws?.speaker).toBe("SOCRATES");
    expect(laws?.speakerRule).toBe("turn-continues");
  });
});

describe("casting without content", () => {
  it("the palette in casting order: George, Lewis, Fable; the narrator is George", () => {
    expect(PALETTE).toEqual(["bm_george", "bm_lewis", "bm_fable"]);
    expect(NARRATOR_VOICE).toBe("bm_george");
    expect(PALETTE.map((v) => VOICE_NAMES[v])).toEqual(["George", "Lewis", "Fable"]);
  });

  it("Crito: Socrates is George, Crito is Lewis, and the first two turns are in different voices", () => {
    const c = cast(cues);
    expect(c.parts.map((p) => [p.speaker, p.voice])).toEqual([
      ["SOCRATES", "bm_george"],
      ["CRITO", "bm_lewis"],
    ]);
    expect(c.narrated).toBe(false);
    expect(c.voices.length).toBe(cues.length);
    expect(c.voices[0]).toBe("bm_george");
    const second = cues.findIndex((q) => q.speaker === "CRITO");
    expect(c.voices[second]).toBe("bm_lewis");
    cues.forEach((q, i) => expect(c.voices[i]).toBe(q.speaker === "SOCRATES" ? "bm_george" : "bm_lewis"));
    expect(voiceCount(c)).toBe(2);
  });

  it("is deterministic, by order of first appearance, and wraps after the third speaker", () => {
    expect(JSON.stringify(cast(segment(crito)))).toBe(JSON.stringify(cast(cues)));
    const four = segment("BEN: One.\n\nAMY: Two.\n\nCAL: Three.\n\nDOT: Four.\n\nAMY: Five.");
    expect(cast(four).parts.map((p) => [p.speaker, p.voice])).toEqual([
      ["BEN", "bm_george"],
      ["AMY", "bm_lewis"],
      ["CAL", "bm_fable"],
      ["DOT", "bm_george"],
    ]);
    expect(cast(four).voices).toEqual(["bm_george", "bm_lewis", "bm_fable", "bm_george", "bm_lewis"]);
  });

  it("never reads a name: renaming the speakers leaves the cast's voices unchanged", () => {
    const renamed = crito.replace(/^SOCRATES:/gm, "XANTHIPPE:").replace(/^CRITO:/gm, "ZEUS:");
    expect(cast(segment(renamed)).voices).toEqual(cast(cues).voices);
  });

  it("a narrated line before the first label is the narrator's", () => {
    const c = cast(segment("The prison, before dawn.\n\nSOCRATES:  Why?\n\nCRITO:  No reason."));
    expect(c.voices).toEqual(["bm_george", "bm_george", "bm_lewis"]);
    expect(c.narrated).toBe(true);
  });
});

describe("the works without labels are unchanged", () => {
  // SHA-256 of JSON.stringify(segment(text)) at main b8728c1, before speaker labels existed.
  const before: Record<string, string> = {
    cave: "d0c908d34885c3fd1b5ad560e3fd7ebf6d5dd2e14c8db93ccaca4578a69beab5",
    meditations: "fd6d525fce6781a1cbc152977eb2e5985210322d9c29df292e0932d50d61dfbd",
  };
  for (const [slug, hash] of Object.entries(before)) {
    it(`${slug}: the same cues, byte for byte, one narrator voice`, () => {
      const got = segment(text(slug));
      expect(sha(JSON.stringify(got))).toBe(hash);
      expect(got.every((c) => !("speaker" in c) && !("speakerRule" in c))).toBe(true);
      const c = cast(got);
      expect(c.parts).toEqual([]);
      expect(new Set(c.voices)).toEqual(new Set(["bm_george"]));
    });
  }
});

describe("the page tells the truth about the cast", () => {
  const casts = Object.fromEntries(WORKS.map((w) => [w.slug, cast(segment(text(w.slug)))]));

  it("Crito's Bookplate states the cast, and no longer promises voices to come", () => {
    const html = bookplateHtml(WORKS[1]!, casts.crito);
    expect(html).toContain("Socrates: George. Crito: Lewis.");
    expect(html).toContain("The voices come from Kokoro-82M");
    expect(html).not.toMatch(/read aloud|until each part/);
  });

  it("the works without labels say one voice, George", () => {
    for (const w of [WORKS[0]!, WORKS[2]!]) {
      expect(bookplateHtml(w, casts[w.slug])).toContain("One voice, George, reads every part. It is Kokoro-82M");
    }
  });

  it("the listing's voice count comes from the cast", () => {
    expect(metaHtml(WORKS[1]!, 10, casts.crito)).toContain("<span>Two voices</span>");
    expect(metaHtml(WORKS[0]!, 10, casts.cave)).toContain("<span>One voice</span>");
    expect(metaHtml(WORKS[0]!, 10)).not.toMatch(/voice/);
    expect(read("web/src/render.ts")).not.toMatch(/<span>One voice<\/span>/);
  });

  it("the read-along shows the speaker's name before a line that opens a turn, and never the label twice", () => {
    const lines = readLines(cues);
    expect(lines[0]).toEqual({ text: "Why have you come at this hour, Crito?", speaker: "Socrates" });
    const html = readAlongHtml(lines, 2);
    expect(html).toContain('<p class="ra live"><span class="ra-sp">Crito</span> Yes, certainly.</p>');
    expect(html).not.toMatch(/SOCRATES|CRITO:/);
    // Works without labels show every line as printed.
    const caveCues = segment(text("cave"));
    expect(readLines(caveCues)).toEqual(caveCues.map((c) => ({ text: c.text })));
  });

  it("a speaker's name is escaped like any other text from the network", () => {
    const XSS = '"><img src=x onerror=alert(1)>';
    const html = readAlongHtml([{ text: XSS, speaker: XSS }], 0);
    expect(html).not.toContain("<img");
    expect(html).toContain(esc(XSS));
    const bp = bookplateHtml(WORKS[1]!, { parts: [{ speaker: XSS, voice: "bm_george", firstCue: 0 }], narrated: false, voices: ["bm_george"] });
    expect(bp).not.toContain("<img");
  });

  it("names are printed from the label only, each word capitalised", () => {
    expect(speakerName("SOCRATES")).toBe("Socrates");
    expect(speakerName("FIRST CITIZEN")).toBe("First Citizen");
  });
});

describe("the cast's voices are staged and pinned", () => {
  it("fetch-voice pins exactly the palette, George's pin unchanged", () => {
    expect(Object.keys(VOICES)).toEqual([...PALETTE]);
    expect(VOICES.bm_george).toBe("c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc");
  });

  it("the worker speaks each cue in its cast voice, and only a pinned one", () => {
    const worker = read("web/src/narrate.worker.ts");
    expect(worker).toMatch(/tts\.generate\(cues\[i\]!\.spoken, \{ voice \}\)/);
    expect(worker).toMatch(/Object\.hasOwn\(manifest\.voices, voice\)/);
    expect(worker).not.toMatch(/manifest\.narrator/);
    expect(read("web/src/main.ts")).toContain('worker.postMessage({ type: "render", cues, voices: text.cast.voices } satisfies ToWorker);');
  });
});

describe("names on the dial", () => {
  it("the scale labels each station with the work's name; the numbers stay in the readout and the Bookplate", () => {
    const svg = scaleSvg(WORKS, 2.5, 1);
    expect([...svg.matchAll(/<text class="lb[^"]*"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])).toEqual(["Cave", "Crito", "Meditations"]);
    expect(svg).not.toMatch(/>00\d</);
    expect(read("web/src/device/radio.ts")).toContain("readout.textContent = `514 · ${w.station}`;");
    for (const w of WORKS) expect(bookplateHtml(w)).toContain(`<dt>Station</dt><dd><span data-numeral>514 · ${w.station}</span> on the dial</dd>`);
  });

  it("the sentence that decoded the bare numbers is gone", () => {
    expect(read("web/index.html")).not.toMatch(/dial-key|Each station on the dial is one work/);
    expect(read("web/src/style.css")).not.toMatch(/dial-key/);
  });

  it("the names are set in the structure voice, large enough to read on a phone", () => {
    const css = read("web/src/style.css");
    const rule = /\.dw-scale \.lb \{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toMatch(/font: 500 13px var\(--font-structure\)/);
  });
});
