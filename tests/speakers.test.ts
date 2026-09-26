// T2b: labelled scripts (Law 3 rule 1) and casting without content. Crito's
// speakers are found from the labels alone, each is cast a voice in the
// order they first speak, the labels are never spoken, and the works with
// no labels are exactly as they were.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { answerKey } from "../scripts/answer-key.mjs";
import { parse as parseYaml } from "yaml";
import { STAGED_DIRS, VOICES, stage } from "../scripts/fetch-voice.mjs";
import { warmingLine } from "../web/src/download-size";
import { CAST_FAILED } from "../web/src/status-copy";
import { neededBytes, type SizedManifest } from "../web/src/voice-cache";
import { WORKS } from "../web/src/catalogue";
import { ALL_VOICES, NARRATORS, PALETTE, PALETTE_VOICES, VOICE_NAMES, cast, castVoices, narratorVoice, speakerName, tryCast, voiceCount } from "../web/src/engine/cast";
import { rebuild, segment, speakerLabel } from "../web/src/engine/segment";
import { bookplateHtml, esc, eyebrowHtml, metaHtml, presetKeysHtml, readAlongHtml, readLines, scaleSvg } from "../web/src/render";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const text = (slug: string) => read(`web/public/works/${slug}.txt`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const crito = text("crito");
const cues = segment(crito);
// The answer key: made apart from the engine, from the names in Gutenberg eBook 1657's list of persons.
const key = answerKey(crito, ["SOCRATES", "CRITO"]) as { speaker: string; opens: string }[];

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
  it("the answer key finds Crito's 95 turns, 48 by Socrates and 47 by Crito, alternating", () => {
    expect(key.length).toBe(95);
    expect(key.filter((t) => t.speaker === "SOCRATES").length).toBe(48);
    expect(key.filter((t) => t.speaker === "CRITO").length).toBe(47);
    key.forEach((t, i) => expect(t.speaker).toBe(i % 2 === 0 ? "SOCRATES" : "CRITO"));
    expect(key[0]).toEqual({ speaker: "SOCRATES", opens: "Why have you come at this" });
    expect(key.at(-1)).toEqual({ speaker: "SOCRATES", opens: "Leave me then, Crito, to fulfil" });
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
  const sheet = WORKS[1]!.cast;

  it("two fixed narrators (male placeholder George, female Heart) and a character palette without them", () => {
    expect(NARRATORS).toEqual({ m: "bm_george", f: "af_heart" });
    expect(PALETTE).toEqual(["bm_fable", "bm_lewis"]);
    for (const n of Object.values(NARRATORS)) expect(PALETTE as readonly string[]).not.toContain(n);
    expect(ALL_VOICES).toEqual(["bm_george", "af_heart", "bm_fable", "bm_lewis"]);
    expect(ALL_VOICES.map((v) => VOICE_NAMES[v])).toEqual(["George", "Heart", "Fable", "Lewis"]);
  });

  it("Crito: the sheet asks for a male narrator; Socrates is Fable, Crito is Lewis, neither a narrator voice", () => {
    expect(sheet).toEqual({ narrator: "m", speakers: { SOCRATES: "m", CRITO: "m" } });
    const c = cast(cues, sheet);
    expect(c.narrator).toBe("bm_george");
    expect(c.parts.map((p) => [p.speaker, p.voice])).toEqual([
      ["SOCRATES", "bm_fable"],
      ["CRITO", "bm_lewis"],
    ]);
    expect(c.narrated).toBe(false);
    expect(c.voices.length).toBe(cues.length);
    // The first two turns are in different voices.
    const second = cues.findIndex((q) => q.speaker === "CRITO");
    expect(c.voices[0]).toBe("bm_fable");
    expect(c.voices[second]).toBe("bm_lewis");
    cues.forEach((q, i) => expect(c.voices[i]).toBe(q.speaker === "SOCRATES" ? "bm_fable" : "bm_lewis"));
    expect(c.voices).not.toContain("bm_george");
    expect(voiceCount(c)).toBe(2);
  });

  it("is deterministic, by order of first appearance, and wraps after the palette", () => {
    expect(JSON.stringify(cast(segment(crito), sheet))).toBe(JSON.stringify(cast(cues, sheet)));
    const four = segment("BEN: One.\n\nAMY: Two.\n\nCAL: Three.\n\nAMY: Four.");
    expect(cast(four).parts.map((p) => [p.speaker, p.voice])).toEqual([
      ["BEN", "bm_fable"],
      ["AMY", "bm_lewis"],
      ["CAL", "bm_fable"],
    ]);
    expect(cast(four).voices).toEqual(["bm_fable", "bm_lewis", "bm_fable", "bm_lewis"]);
  });

  it("never reads a name: renaming the speakers leaves the cast's voices unchanged", () => {
    const renamed = crito.replace(/^SOCRATES:/gm, "XANTHIPPE:").replace(/^CRITO:/gm, "ZEUS:");
    expect(cast(segment(renamed)).voices).toEqual(cast(cues, sheet).voices);
  });

  it("narration is the narrator's role, apart from the speakers: the male narrator by default, af_heart where the sheet says f", () => {
    const src = segment("The prison, before dawn.\n\nSOCRATES:  Why?\n\nCRITO:  No reason.");
    const byDefault = cast(src);
    expect(byDefault.narrator).toBe("bm_george");
    expect(byDefault.voices).toEqual(["bm_george", "bm_fable", "bm_lewis"]);
    expect(byDefault.narrated).toBe(true);
    const female = cast(src, { narrator: "f" });
    expect(female.narrator).toBe("af_heart");
    expect(female.voices).toEqual(["af_heart", "bm_fable", "bm_lewis"]);
    expect(narratorVoice({ narrator: "f" })).toBe("af_heart");
    // A work with no labels, declared f, is read entirely by af_heart.
    expect(new Set(cast(segment(text("cave")), { narrator: "f" }).voices)).toEqual(new Set(["af_heart"]));
  });

  it("narrator voices never go to characters, even when a palette offers them", () => {
    const withNarrators = [
      { id: "bm_george", sex: "m" as const },
      { id: "af_heart", sex: "f" as const },
      { id: "m1", sex: "m" as const },
      { id: "f1", sex: "f" as const },
    ];
    const names = Array.from({ length: 8 }, (_, i) => `S${String.fromCharCode(65 + i)}`);
    for (const s of [undefined, { narrator: "m" as const }, { narrator: "f" as const }]) {
      const got = castVoices(names.map((speaker) => ({ speaker, words: 1 })), s, withNarrators);
      for (const v of got.values()) expect(Object.values(NARRATORS) as string[]).not.toContain(v);
    }
    for (const w of WORKS) {
      const c = cast(segment(text(w.slug)), w.cast);
      for (const p of c.parts) expect(Object.values(NARRATORS) as string[]).not.toContain(p.voice);
    }
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
  const casts = Object.fromEntries(WORKS.map((w) => [w.slug, cast(segment(text(w.slug)), w.cast)]));

  it("Crito's Bookplate states the cast, and no longer promises voices to come", () => {
    const html = bookplateHtml(WORKS[1]!, casts.crito);
    expect(html).toContain("Socrates: Fable. Crito: Lewis.");
    expect(html).toContain("The speech is made by Kokoro-82M");
    expect(html).not.toMatch(/read aloud|until each part/);
  });

  it("the works without labels say one voice, George", () => {
    for (const w of [WORKS[0]!, WORKS[2]!]) {
      expect(bookplateHtml(w, casts[w.slug])).toContain("One voice, George, reads every part. The speech is made by Kokoro-82M");
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
  it("fetch-voice pins exactly the cast's voices (both narrators and the palette), George's pin unchanged", () => {
    expect(Object.keys(VOICES)).toEqual([...ALL_VOICES]);
    expect(VOICES.af_heart).toBe("d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b");
    expect(VOICES.bm_george).toBe("c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc");
  });

  it("the worker speaks each cue in its cast voice, and only a pinned one", () => {
    const worker = read("web/src/narrate.worker.ts");
    expect(worker).toMatch(/tts\.generate\(cues\[i\]!\.spoken, \{ voice \}\)/);
    expect(worker).toMatch(/Object\.hasOwn\(manifest\.voices, voice\)/);
    expect(worker).not.toMatch(/manifest\.narrator/);
    expect(read("web/src/main.ts")).toContain('worker.postMessage({ type: "render", cues, voices: cast.voices } satisfies ToWorker);');
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

describe("castVoices: the replaceable casting rule, and the curator's cast sheet", () => {
  const stats = (...names: string[]) => names.map((speaker) => ({ speaker, words: 10 }));
  const mixed = [
    { id: "m1", sex: "m" as const },
    { id: "f1", sex: "f" as const },
    { id: "m2", sex: "m" as const },
    { id: "f2", sex: "f" as const },
  ];

  it("without a sheet: order of first appearance through the palette, wrapping", () => {
    expect([...castVoices(stats("A", "B", "C", "D", "E"), undefined, mixed)]).toEqual([
      ["A", "m1"],
      ["B", "f1"],
      ["C", "m2"],
      ["D", "f2"],
      ["E", "m1"],
    ]);
  });

  it("a speaker the sheet declares f never receives a male voice, and m never a female one", () => {
    for (let n = 1; n <= 6; n++) {
      const names = Array.from({ length: n }, (_, i) => `S${String.fromCharCode(65 + i)}`);
      for (const sex of ["f", "m"] as const) {
        const sheet = { narrator: "m" as const, speakers: Object.fromEntries(names.map((s) => [s, sex])) };
        const got = castVoices(stats(...names), sheet, mixed);
        for (const s of names) expect(mixed.find((v) => v.id === got.get(s))!.sex, `${s} of ${n}`).toBe(sex);
      }
    }
    // Only the declared speaker is constrained; the next speaker takes the first voice not yet used.
    const got = castVoices(stats("A", "B"), { narrator: "m", speakers: { A: "f" } }, mixed);
    expect([...got]).toEqual([
      ["A", "f1"],
      ["B", "m1"],
    ]);
  });

  it("refuses a sheet the palette cannot honour, rather than casting the wrong voice", () => {
    // Today's character palette is all male: a character declared f cannot be cast, so casting refuses.
    expect(() => castVoices(stats("A"), { narrator: "f", speakers: { A: "f" } }, PALETTE_VOICES)).toThrow(/no character voice in the palette for A \(declared f\)/);
  });

  it("the palette's voices are the pinned ones, in casting order, and all male (Kokoro's bm_)", () => {
    expect(PALETTE_VOICES.map((v) => v.id)).toEqual([...PALETTE]);
    expect(PALETTE_VOICES.every((v) => v.sex === "m")).toBe(true);
  });

  it("Crito's sheet names exactly the labelled speakers, and the cast with it is the cast without it", () => {
    const sheet = WORKS[1]!.cast!;
    expect(Object.keys(sheet.speakers!).sort()).toEqual([...new Set(cues.map((c) => c.speaker!))].sort());
    expect(cast(cues, sheet)).toEqual(cast(cues));
    // No sheet ever carries anything but voice sex.
    for (const w of WORKS) {
      if (!w.cast) continue;
      expect(Object.keys(w.cast).sort()).toEqual(["narrator", "speakers"]);
      for (const v of [w.cast.narrator, ...Object.values(w.cast.speakers ?? {})]) expect(["m", "f"]).toContain(v);
    }
    expect(WORKS[0]!.cast).toBeUndefined();
    expect(WORKS[2]!.cast).toBeUndefined();
  });

  it("the speakers reach castVoices in order of first appearance, with their word counts", () => {
    const parts = cast(cues, WORKS[1]!.cast).parts;
    expect(parts.map((p) => p.speaker)).toEqual(["SOCRATES", "CRITO"]);
    const spoken = (who: string) => cues.filter((c) => c.speaker === who).reduce((n, c) => n + c.spoken.split(/\s+/).filter(Boolean).length, 0);
    expect(parts.map((p) => p.words)).toEqual([spoken("SOCRATES"), spoken("CRITO")]);
    expect(parts[0]!.words).toBeGreaterThan(parts[1]!.words);
  });

  it("the Bookplate shows Crito's cast sheet, and no sheet where there is none", () => {
    const withSheet = bookplateHtml(WORKS[1]!, cast(cues, WORKS[1]!.cast));
    expect(withSheet).toContain("The curator's cast sheet, from the edition's list of persons, asks only for voice sex: narrator male; Socrates male; Crito male.");
    expect(bookplateHtml(WORKS[0]!)).not.toContain("cast sheet");
  });
});

describe("T2b review: labels are never headings or honorifics", () => {
  it("refuses the reviewer's cases: headings, Roman numerals and honorifics with a full stop", () => {
    const refused = [
      "BOOK II. Of the soul",
      "BOOK ONE: The beginning",
      "CHAPTER THE FIRST. In which",
      "SCENE: The Prison of Socrates.",
      "LETTER IV. To my sister",
      "ACT ONE. A room",
      "PART TWO: The return",
      "INTRODUCTION. The Crito",
      "ARGUMENT: Socrates is in prison",
      "NOTE. The text is corrupt",
      "MR. Darcy bowed.",
      "MRS. Bennet said nothing.",
      "DR. Johnson laughed.",
      "ST. Paul's was quiet.",
      "NO. 7 was empty.",
      "XIV. Of the soul",
    ];
    for (const para of refused) expect(speakerLabel(para), para).toBeNull();
    for (const para of ["SOCRATES:  Why?", "CRITO. Yes.", "FIRST CITIZEN: Before we proceed", "MR SMITH: Good day."]) expect(speakerLabel(para), para).not.toBeNull();
  });

  it("every work's detected speakers are exactly its cast sheet's, and a work with no sheet detects none", () => {
    for (const w of WORKS) {
      const found = [...new Set(segment(text(w.slug)).flatMap((c) => (c.speaker ? [c.speaker] : [])))].sort();
      expect(found, w.slug).toEqual(Object.keys(w.cast?.speakers ?? {}).sort());
    }
  });
});

describe("T2b review: a cast failure silences one station only", () => {
  it("tryCast returns null where the sheet cannot be honoured, and the cast otherwise", () => {
    expect(tryCast(cues, { narrator: "m", speakers: { SOCRATES: "f", CRITO: "m" } })).toBeNull();
    expect(tryCast(cues, WORKS[1]!.cast)).toEqual(cast(cues, WORKS[1]!.cast));
    expect(CAST_FAILED).toBe("Dial could not cast this work's voices.");
  });

  it("the page casts each work on its own, and only a cast work can be tuned in", () => {
    const main = read("web/src/main.ts");
    expect(main).toContain("cast: tryCast(cues, w.cast)");
    expect(main).toMatch(/tune\.disabled = here \|\| !texts\.get\(w\.slug\)\?\.cast;/);
    expect(main).not.toMatch(/\bcast\(cues/);
  });
});

describe("T2b review: catalogue numbers only in the dial's readout and the Bookplate", () => {
  it("the station line gives the minutes only", () => {
    expect(eyebrowHtml(36)).toBe("about <span data-numeral>36</span> min");
    expect(eyebrowHtml()).toBe("");
  });

  it("the preset keys show the name, and are named by the title", () => {
    const keys = presetKeysHtml(WORKS, 1);
    expect(keys).not.toMatch(/00\d|514|data-numeral/);
    expect([...keys.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual(WORKS.map((w) => esc(w.title)));
    expect([...keys.matchAll(/<span class="t">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual(["The Cave", "Crito", "Meditations"]);
  });

  it("the Tune knob and the on-air line name the work, not its number; the dial's own slider keeps it", () => {
    const radio = read("web/src/device/radio.ts");
    expect(radio).toContain('tuneKnob?.setAttribute("aria-valuetext", w.title);');
    expect(radio).toContain("win.setAttribute(\"aria-valuetext\", `514, No. ${w.station}, ${w.title}`);");
    expect(read("web/src/main.ts")).not.toMatch(/514/);
  });
});

describe("T2b review: the size shown is what actually downloads", () => {
  beforeAll(async () => {
    if (!existsSync(path.join(STAGED_DIRS.voice, "manifest.json"))) await stage();
  }, 120_000);
  const manifest = () => JSON.parse(readFileSync(path.join(STAGED_DIRS.voice, "manifest.json"), "utf8")) as SizedManifest & { totalBytes: number; voices: Record<string, string>; narrator?: string };
  const tokenizerAndConfig = (m: SizedManifest) => new Set(Object.keys(m.sizes).filter((p) => p.startsWith(`/voice/models/${m.repo}/`) && !p.includes("/onnx/")));
  const everything = (m: SizedManifest, voices: string[]) => ({ model: true, modelFiles: tokenizerAndConfig(m), runtime: true, voices: new Set(voices) });
  const nothing = { model: false, modelFiles: new Set<string>(), runtime: false, voices: new Set<string>() };
  const voiceSize = (m: SizedManifest, id: string) => m.sizes[`/voice/voices/${id}.bin`]!;

  it("the manifest lists every staged file's size; they sum to totalBytes; there is no second narrator field", () => {
    const m = manifest();
    expect(Object.values(m.sizes).reduce((a, b) => a + b, 0)).toBe(m.totalBytes);
    for (const id of ALL_VOICES) expect(voiceSize(m, id), id).toBeGreaterThan(0);
    for (const part of m.parts) expect(m.sizes[`/voice/models/${m.repo}/onnx/${part}`]).toBeGreaterThan(0);
    expect(Object.keys(m.sizes).filter((p) => p.startsWith("/ort/")).length).toBe(2);
    expect(m.narrator).toBeUndefined();
  });

  it("a cache holding everything except Crito's new voices: only those voices are counted and named", () => {
    const m = manifest();
    const crito = [...new Set(cast(cues, WORKS[1]!.cast).voices)];
    expect(crito).toEqual(["bm_fable", "bm_lewis"]);
    const got = neededBytes(m, crito, everything(m, ["bm_george"]));
    expect(got).toEqual({ bytes: voiceSize(m, "bm_fable") + voiceSize(m, "bm_lewis"), need: "voices", missingVoices: 2 });
    expect(warmingLine(got.bytes, got.need, "Crito", got.missingVoices)).toBe("Adding the voices for Crito (about 1 MB) to this device.");
    expect(warmingLine(voiceSize(m, "bm_george"), "voices", "the Cave", 1)).toBe("Adding the voice for the Cave (about 1 MB) to this device.");
  });

  it("everything held: nothing downloads, and no download is claimed", () => {
    const m = manifest();
    const got = neededBytes(m, ["bm_george"], everything(m, ["bm_george"]));
    expect(got).toEqual({ bytes: 0, need: "none", missingVoices: 0 });
    expect(warmingLine(got.bytes, got.need, "the Cave", 0)).toBe("Warming the voice from this device.");
  });

  it("a first visit downloads the model, tokenizer and config, the runtime, and only that work's voices", () => {
    const m = manifest();
    const shared = m.totalBytes - ALL_VOICES.reduce((n, id) => n + voiceSize(m, id), 0);
    for (const w of WORKS) {
      const voices = [...new Set(cast(segment(text(w.slug)), w.cast).voices)];
      const got = neededBytes(m, voices, nothing);
      expect(got.need, w.slug).toBe("all");
      expect(got.bytes, w.slug).toBe(shared + voices.reduce((n, id) => n + voiceSize(m, id), 0));
      expect(got.bytes).toBeLessThan(m.totalBytes);
    }
  });

  it("the worker loads, and the loader fetches and keeps, only the voices the work's cast uses", () => {
    expect(read("web/src/narrate.worker.ts")).toContain("await loadVoice([...new Set(voices)],");
    const voice = read("web/src/voice.ts");
    expect(voice).toMatch(/for \(const id of cast\) \{\s*const pin = manifest\.voices\[id\]!;\s*if \(heldVoices\.has\(id\)\) continue;/);
    expect(voice).not.toMatch(/Object\.entries\(manifest\.voices\)/);
  });

  it("the contract checks every pinned voice file is served, and nothing names a second narrator", () => {
    const contract = parseYaml(read("contract.yaml")) as { checks: { path?: string; field?: string }[] };
    const served = contract.checks.flatMap((c) => (c.path?.startsWith("/voice/voices/") ? [c.path] : []));
    expect(served).toEqual(Object.keys(VOICES).map((id) => `/voice/voices/${id}.bin`));
    expect(contract.checks.some((c) => c.field === "narrator")).toBe(false);
  });
});
