// T2c: Dial casts voices with a deterministic algorithm over the measured
// voice table (design/voices.json), with the founder's two fixed narrators
// (am_michael, af_heart). The rules are in web/src/engine/cast.ts's header.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKS } from "../web/src/catalogue";
import {
  CAST_ENGINE_VERSION,
  CHARACTER_VOICES,
  GRADES,
  MIN_CENTROID_HZ,
  MIN_F0_CENTS,
  NARRATOR_WEIGHT,
  NARRATORS,
  PACE_BAND,
  TABLE,
  alternations,
  cast,
  castReport,
  castVoices,
  contrast,
  distinct,
  tryCast,
  type CastSheet,
  type SpeakerStats,
  type Voice,
} from "../web/src/engine/cast";
import { segment } from "../web/src/engine/segment";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = (slug: string) => readFileSync(path.join(root, `web/public/works/${slug}.txt`), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const byId = (id: string) => TABLE.find((v) => v.id === id)!;
const narratorIds = Object.values(NARRATORS) as string[];

/** A deterministic generator (mulberry32), so the "many inputs" tests are the same every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random work: n speakers, word counts, a turn order, and a sheet (or none). */
function randomWork(seed: number) {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 8);
  const names = Array.from({ length: n }, (_, i) => `S${i}`);
  const turns = Array.from({ length: 10 + Math.floor(r() * 60) }, () => names[Math.floor(r() * n)]!);
  const speakers: SpeakerStats[] = names.map((speaker) => ({ speaker, words: 1 + Math.floor(r() * 500) }));
  const accent = r() < 0.3 ? (r() < 0.5 ? "us" : "uk") : undefined;
  const sheet: CastSheet | undefined = r() < 0.25 ? undefined : { narrator: r() < 0.5 ? "m" : "f", ...(accent ? { accent } : {}), speakers: Object.fromEntries(names.map((s) => [s, r() < 0.5 ? "m" : "f"])) };
  return { speakers, turns, sheet };
}

const WORK_SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe("the measured table, as casting reads it", () => {
  it("rounds every measurement to an integer once; the table is pinned, so a changed engine or table is seen", () => {
    for (const v of TABLE) for (const k of ["wpm10", "f0Cents", "centroidHz"] as const) expect(Number.isInteger(v[k]), `${v.id} ${k}`).toBe(true);
    expect(TABLE.length).toBe(28);
    expect(sha(JSON.stringify(TABLE))).toBe("9064694857218b9476a5f1517611d99e0e5a343527f22aaa70a7fe1635ffcbaf");
    expect(byId("am_michael")).toEqual({ id: "am_michael", sex: "m", accent: "us", grade: "C+", wpm10: 1676, f0Cents: 1194, centroidHz: 2429 });
    expect(byId("af_nicole").wpm10).toBe(1210);
  });

  it("contrast is an integer from 0 to 1000, zero for a voice with itself, and symmetric", () => {
    for (const a of TABLE) {
      expect(contrast(a, a)).toBe(0);
      for (const b of TABLE) {
        const c = contrast(a, b);
        expect(Number.isInteger(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1000);
        expect(contrast(b, a)).toBe(c);
      }
    }
  });

  it("alternation counts direct exchanges in turn order, either way round", () => {
    const alt = alternations(["A", "B", "A", "A", "C", "B", "A"]);
    const get = (a: string, b: string) => alt.get(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`) ?? 0;
    expect([get("A", "B"), get("A", "C"), get("B", "C")]).toEqual([3, 1, 1]);
  });
});

describe("determinism", () => {
  it("the same input gives the same cast and the same hash, whatever the palette's order", () => {
    for (const seed of WORK_SEEDS.slice(0, 50)) {
      const { speakers, turns, sheet } = randomWork(seed);
      const once = JSON.stringify([...castVoices(speakers, sheet, TABLE, turns)]);
      const again = JSON.stringify([...castVoices(speakers, sheet, TABLE, turns)]);
      const reversed = JSON.stringify([...castVoices(speakers, sheet, [...TABLE].reverse(), turns)]);
      expect(sha(again), `seed ${seed}`).toBe(sha(once));
      expect(sha(reversed), `seed ${seed}`).toBe(sha(once));
    }
    const crito = segment(text("crito"));
    expect(sha(JSON.stringify(cast(crito, WORKS[1]!.cast)))).toBe(sha(JSON.stringify(cast(segment(text("crito")), WORKS[1]!.cast))));
  });
});

describe("the rules hold for every input", () => {
  it("narrator voices are never cast to characters, even from a palette that offers them", () => {
    for (const seed of WORK_SEEDS) {
      const { speakers, turns, sheet } = randomWork(seed);
      for (const [speaker, c] of castVoices(speakers, sheet, TABLE, turns)) expect(narratorIds, `seed ${seed} ${speaker}`).not.toContain(c.voice);
    }
  });

  it("the sheet's sex is always honoured, or casting throws and the station is left uncast", () => {
    for (const seed of WORK_SEEDS) {
      const { speakers, turns, sheet } = randomWork(seed);
      for (const [speaker, c] of castVoices(speakers, sheet, TABLE, turns)) {
        const want = sheet?.speakers?.[speaker];
        if (want) expect(byId(c.voice).sex, `seed ${seed} ${speaker}`).toBe(want);
      }
    }
    const males = TABLE.filter((v) => v.sex === "m");
    expect(() => castVoices([{ speaker: "A", words: 5 }], { narrator: "m", speakers: { A: "f" } }, males)).toThrow(/declared f/);
    const crito = segment(text("crito"));
    const female = { narrator: "m", speakers: { SOCRATES: "f", CRITO: "m" } } as const;
    expect(byId(tryCast(crito, female)!.parts[0]!.voice).sex).toBe("f");
    expect(tryCast(crito, female, males)).toBeNull();
  });

  it("no voice outside the pace band is ever chosen (af_nicole, 121 wpm, is too slow)", () => {
    const inBand = (v: Voice) => v.wpm10 >= PACE_BAND[0] && v.wpm10 <= PACE_BAND[1];
    expect(inBand(byId("af_nicole"))).toBe(false);
    for (const seed of WORK_SEEDS) {
      const { speakers, turns, sheet } = randomWork(seed);
      for (const c of castVoices(speakers, sheet, TABLE, turns).values()) expect(inBand(byId(c.voice)), `seed ${seed} ${c.voice}`).toBe(true);
    }
    // Fourteen women and every female voice: af_nicole's grade (B-) would win her a part, her pace never does.
    const women = Array.from({ length: 14 }, (_, i) => ({ speaker: `W${i}`, words: 100 - i }));
    const got = castVoices(women, { narrator: "m", speakers: Object.fromEntries(women.map((w) => [w.speaker, "f" as const])) }, TABLE);
    expect([...got.values()].map((c) => c.voice)).not.toContain("af_nicole");
    // A pool of only out-of-band voices is no pool: the sheet cannot be honoured.
    expect(() => castVoices([{ speaker: "A", words: 1 }], { narrator: "m", speakers: { A: "f" } }, [byId("af_nicole")])).toThrow(/declared f/);
  });

  it("never below grade C (af_sky, C-, is out); D+ only when a declared sex has nothing better; never D or worse", () => {
    const low = (g: string) => ["F", "F+", "D-", "D"].includes(g);
    for (const seed of WORK_SEEDS) {
      const { speakers, turns, sheet } = randomWork(seed);
      for (const c of castVoices(speakers, sheet, TABLE, turns).values()) expect(["C-", "D+", "F", "F+", "D-", "D"]).not.toContain(byId(c.voice).grade);
    }
    const women = Array.from({ length: 14 }, (_, i) => ({ speaker: `W${i}`, words: 100 - i }));
    const got = castVoices(women, { narrator: "m", speakers: Object.fromEntries(women.map((w) => [w.speaker, "f" as const])) }, TABLE);
    expect([...got.values()].map((c) => c.voice)).not.toContain("af_sky");
    // With only D+ men left, a declared man falls back to bm_lewis; an undeclared speaker does not.
    const palette = [byId("bm_lewis"), byId("am_echo"), byId("af_kore")];
    expect(castVoices([{ speaker: "A", words: 1 }], { narrator: "m", speakers: { A: "m" } }, palette).get("A")!.voice).toBe("bm_lewis");
    expect(castVoices([{ speaker: "A", words: 1 }], undefined, palette).get("A")!.voice).toBe("af_kore");
    expect(low(byId("am_echo").grade)).toBe(true);
    expect(() => castVoices([{ speaker: "A", words: 1 }], { narrator: "m", speakers: { A: "m" } }, [byId("am_echo")])).toThrow(/declared m/);
  });
});

describe("the most-alternating pair is kept apart", () => {
  // Synthetic voices, all in the pace band and the grade filter. A (most words) takes a1.
  // B's best score alone is b_close (grade A-, but only 50 cents and 0 Hz from a1);
  // the rule sends B to b_far (C, 300 cents away).
  const v = (id: string, grade: string, f0Cents: number, accent = "us", centroidHz = 2200): Voice => ({ id, sex: "m", accent, grade, wpm10: 1800, f0Cents, centroidHz });
  const a1 = v("a1", "A", 1400);
  const bClose = v("b_close", "A-", 1450);
  const bFar = v("b_far", "C", 1700);
  const speakers = [
    { speaker: "A", words: 500 },
    { speaker: "B", words: 400 },
    { speaker: "C", words: 100 },
  ];
  // A and B exchange twice; C once with each.
  const turns = ["A", "B", "A", "C", "B"];

  it("on a 3-speaker fixture, B's naive best is too close to A, so B is cast apart", () => {
    const got = castVoices(speakers, undefined, [a1, bClose, bFar], turns);
    expect(got.get("A")!.voice).toBe("a1");
    expect(got.get("B")!.voice).toBe("b_far");
    expect(got.get("B")!.reason.contrastRule).toBe("met");
    expect(distinct(a1, bFar)).toBe(true);
    expect(Math.abs(a1.f0Cents - bFar.f0Cents)).toBeGreaterThanOrEqual(MIN_F0_CENTS);
    // Without the rule's candidate, b_close would have scored higher.
    const naive = castVoices(speakers, undefined, [a1, bClose], turns);
    expect(naive.get("B")!.voice).toBe("b_close");
    expect(naive.get("B")!.reason.contrastRule).toBe("unmet");
  });

  it("brightness satisfies the rule too; accent never does (a work has one accent)", () => {
    const bright = v("b_bright", "C", 1420, "us", 2200 + MIN_CENTROID_HZ);
    const got = castVoices(speakers, undefined, [a1, bClose, bright], turns);
    expect(got.get("B")!.voice).toBe("b_bright");
    expect(got.get("B")!.reason.contrastRule).toBe("met");
    expect(distinct(a1, v("b_uk", "C", 1420, "uk"))).toBe(false);
    expect(contrast(a1, v("b_uk", "C", 1400, "uk"))).toBe(0);
  });

  it("Crito's pair (the only pair, all 94 exchanges) meets the rule on the real table", () => {
    const c = cast(segment(text("crito")), WORKS[1]!.cast);
    const [soc, cri] = c.parts;
    expect(distinct(byId(soc!.voice), byId(cri!.voice))).toBe(true);
    expect(cri!.reason.contrastRule).toBe("met");
  });
});

describe("minor parts share voices by colouring the alternation graph", () => {
  // Twelve speakers with no declared sex, and eight US voices at grade C or better in the
  // pace band (af_alloy, af_aoede, af_bella, af_kore, af_nova, af_sarah, am_fenrir, am_puck).
  // The turns walk a ring S0 to S11 and back to S0, twice, with a chord S0-S6:
  // each speaker alternates with two or three others, never more.
  const names = Array.from({ length: 12 }, (_, i) => `S${i}`);
  const ring = [...names, ...names, "S0"];
  const turns = [...ring, "S6", "S0"];
  const words = [3000, 2400, 1900, 1500, 1200, 900, 60, 50, 40, 30, 20, 10];
  const speakers = names.map((speaker, i) => ({ speaker, words: words[i]! }));
  const sheet: CastSheet = { narrator: "m" };

  it("never gives two speakers who alternate the same voice", () => {
    const got = castVoices(speakers, sheet, TABLE, turns);
    const alt = alternations(turns);
    let pairs = 0;
    for (const a of names) {
      for (const b of names) {
        if (a >= b) continue;
        const n = alt.get(`${a}\u0000${b}`) ?? 0;
        if (n > 0) {
          pairs++;
          expect(got.get(a)!.voice, `${a} ${b}`).not.toBe(got.get(b)!.voice);
        }
      }
    }
    expect(pairs).toBe(13);
    const used = new Set([...got.values()].map((c) => c.voice));
    expect([...used].sort()).toEqual(["af_alloy", "af_aoede", "af_bella", "af_kore", "af_nova", "af_sarah", "am_fenrir", "am_puck"]);
    for (const c of got.values()) {
      expect(c.reason.clash).toBeUndefined();
      for (const other of c.reason.sharedWith) expect(alt.get([c.reason.sharedWith[0]!, other].sort().join("\u0000")) ?? 0).toBe(0);
    }
    // The minor parts (under 2%) are among the sharers, and none drops below the grade filter.
    const minor = [...got].filter(([, c]) => c.reason.minor);
    expect(minor.length).toBeGreaterThan(0);
    expect(minor.some(([, c]) => c.reason.sharedWith.length > 0)).toBe(true);
    for (const [, c] of got) {
      expect(byId(c.voice).grade).not.toBe("D+");
      expect(byId(c.voice).accent).toBe("us");
    }
  });
});

describe("one accent per work", () => {
  it("every character voice has the work's accent, the narrator's by default, or the other only with accentFallback recorded", () => {
    for (const seed of WORK_SEEDS) {
      const { speakers, turns, sheet } = randomWork(seed);
      const want = sheet?.accent ?? byId(NARRATORS[sheet?.narrator ?? "m"]).accent;
      for (const [speaker, c] of castVoices(speakers, sheet, TABLE, turns)) {
        expect(c.reason.accent, `seed ${seed} ${speaker}`).toBe(byId(c.voice).accent);
        if (byId(c.voice).accent !== want) expect(c.reason.accentFallback, `seed ${seed} ${speaker}`).toBe(true);
        else expect(c.reason.accentFallback).toBeUndefined();
      }
    }
  });

  it("a sheet may ask for UK: Crito is then cast from the British men", () => {
    const c = cast(segment(text("crito")), { ...WORKS[1]!.cast!, accent: "uk" });
    for (const p of c.parts) expect(byId(p.voice).accent).toBe("uk");
    expect(c.narrator).toBe("am_michael");
  });

  it("a sex with no voice in the work's accent falls back to the other accent for that speaker only, and says so", () => {
    const palette = [byId("am_fenrir"), byId("bf_emma")];
    const got = castVoices(
      [
        { speaker: "A", words: 10 },
        { speaker: "B", words: 5 },
      ],
      { narrator: "m", speakers: { A: "m", B: "f" } },
      palette,
      ["A", "B"],
    );
    expect(got.get("A")!.voice).toBe("am_fenrir");
    expect(got.get("A")!.reason.accentFallback).toBeUndefined();
    expect(got.get("B")!.voice).toBe("bf_emma");
    expect(got.get("B")!.reason.accentFallback).toBe(true);
  });

  it("accent is not a contrast dimension", () => {
    const us = byId("am_fenrir");
    expect(contrast(us, { ...us, id: "x", accent: "uk" })).toBe(0);
  });
});

describe("the score's balance", () => {
  it("in Crito, a C+ voice beats a D voice unless its contrast is very poor", () => {
    const crito = castReport(cast(segment(text("crito")), WORKS[1]!.cast)).parts[1]!;
    const gap = (GRADES.indexOf("C+") - GRADES.indexOf("D")) * crito.share;
    // The contrast term tops out at 1000 (the pair makes every exchange): a D voice would
    // need over 836 per mille more contrast with Socrates than the C+ voice to win.
    expect(gap).toBe(836);
    expect(gap).toBeGreaterThan(800);
    expect(NARRATOR_WEIGHT).toBeLessThan(gap);
  });

  it("CAST_ENGINE_VERSION is defined once, here", () => {
    expect(CAST_ENGINE_VERSION).toBe("2");
  });
});

describe("the catalogue's casts", () => {
  it("Crito, from the real text: Socrates is am_fenrir, Crito is am_puck, both American, with the score's parts", () => {
    const report = castReport(cast(segment(text("crito")), WORKS[1]!.cast));
    expect(report.narrator).toBe("am_michael");
    expect(report.parts).toEqual([
      { speaker: "SOCRATES", voice: "am_fenrir", words: 4154, quality: 7, share: 790, qualityPart: 5530, contrastPart: 0, narratorPart: 57, score: 5587, accent: "us", minor: false, sharedWith: [] },
      { speaker: "CRITO", voice: "am_puck", words: 1098, quality: 7, share: 209, qualityPart: 1463, contrastPart: 245, narratorPart: 51, score: 1759, accent: "us", minor: false, sharedWith: [], contrastRule: "met" },
    ]);
    for (const p of report.parts) expect(CHARACTER_VOICES.map((v) => v.id)).toContain(p.voice);
  });

  it("the Cave and the Meditations are narrated by am_michael, and only by him", () => {
    for (const slug of ["cave", "meditations"]) {
      const w = WORKS.find((x) => x.slug === slug)!;
      const c = cast(segment(text(slug)), w.cast);
      expect(c.narrator, slug).toBe("am_michael");
      expect(new Set(c.voices), slug).toEqual(new Set(["am_michael"]));
      expect(castReport(c).parts).toEqual([]);
    }
  });
});
