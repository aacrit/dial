// T2c: Dial casts voices with a deterministic algorithm over the measured
// voice table (design/voices.json), with the founder's two fixed narrators
// (am_michael, af_heart). The rules are in web/src/engine/cast.ts's header.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  it("every rounding is at least 1e-6 from a tie, so no engine's last-bit difference can move a value", () => {
    const table = JSON.parse(readFileSync(path.join(root, "design/voices.json"), "utf8")) as { voices: { id: string; wpm_as_played: number; median_f0_hz: number; spectral_centroid_hz: number }[] };
    for (const row of table.voices) {
      for (const [k, x] of [
        ["wpm10", row.wpm_as_played * 10],
        ["f0Cents", 1200 * Math.log2(row.median_f0_hz / 55)],
        ["centroidHz", row.spectral_centroid_hz],
      ] as const) {
        const frac = x - Math.floor(x);
        // Values already integral (frac 0) or a tenth away from one are far from the .5 tie.
        expect(Math.abs(frac - 0.5), `${row.id} ${k}`).toBeGreaterThanOrEqual(1e-6);
      }
    }
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
  // Twelve speakers, even-numbered men and odd-numbered women, and the US voices at grade C or
  // better in the pace band: two men (am_fenrir, am_puck), six women (af_alloy, af_aoede,
  // af_bella, af_kore, af_nova, af_sarah). The six men must share the two male voices.
  // The turns walk a ring S0 to S11 and back to S0, twice, with a chord S0-S6:
  // each speaker alternates with two or three others, never more.
  const names = Array.from({ length: 12 }, (_, i) => `S${i}`);
  const ring = [...names, ...names, "S0"];
  const turns = [...ring, "S6", "S0"];
  const words = [3000, 2400, 1900, 1500, 1200, 900, 60, 50, 40, 30, 20, 10];
  const speakers = names.map((speaker, i) => ({ speaker, words: words[i]! }));
  const sheet: CastSheet = { narrator: "m", speakers: Object.fromEntries(names.map((n, i) => [n, i % 2 === 0 ? "m" : "f"])) as Record<string, "m" | "f"> };

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
    for (const [name, c] of got) {
      expect(c.reason.clash).toBeUndefined();
      for (const other of c.reason.sharedWith) expect(alt.get([name, other].sort().join("\u0000")) ?? 0, `${name} ${other}`).toBe(0);
    }
    // The minor parts (under 2%) are among the sharers, and none drops below the grade filter.
    const minor = [...got].filter(([, c]) => c.reason.minor);
    expect(minor.map(([n]) => n)).toEqual(["S6", "S7", "S8", "S9", "S10", "S11"]);
    expect(minor.filter(([, c]) => c.reason.sharedWith.length > 0).map(([n]) => n)).toEqual(["S6", "S8", "S10"]);
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
  // Two speakers who make every exchange; A (grade A voice) is cast first. B chooses between
  // b_good (B-, 200 cents from A) and b_far (C, two grades lower, 700 cents from A).
  const v = (id: string, grade: string, f0Cents: number): Voice => ({ id, sex: "m", accent: "us", grade, wpm10: 1800, f0Cents, centroidHz: 2200 });
  const a1 = v("a1", "A", 1400);
  const bGood = v("b_good", "B-", 1600);
  const bFar = v("b_far", "C", 2100);
  const turns = ["A", "B", "A", "B"];
  const pick = (aWords: number, bWords: number) =>
    castVoices(
      [
        { speaker: "A", words: aWords },
        { speaker: "B", words: bWords },
      ],
      undefined,
      [a1, bGood, bFar],
      turns,
    ).get("B")!;

  it("a major part (half the words) takes the better grade over a more contrasting voice", () => {
    const got = pick(500, 500);
    expect(got.voice).toBe("b_good");
    expect(got.reason.qualityPart).toBe(8 * 500);
    expect(contrast(bFar, a1) - contrast(bGood, a1)).toBeLessThan(2 * 500);
  });

  it("a minor part (2% of the words) takes the more contrasting voice over the better grade", () => {
    const got = pick(980, 20);
    expect(got.voice).toBe("b_far");
    expect(contrast(bFar, a1) - contrast(bGood, a1)).toBeGreaterThan(2 * 20);
  });

  it("the narrator's contrast counts only where the narrator speaks", () => {
    const speakers = [{ speaker: "A", words: 1 }];
    expect(castVoices(speakers, undefined, TABLE, ["A"], false).get("A")!.reason.narratorPart).toBe(0);
    expect(castVoices(speakers, undefined, TABLE, ["A"], true).get("A")!.reason.narratorPart).toBeGreaterThan(0);
    expect(castVoices(speakers, undefined, TABLE, ["A"], true).get("A")!.reason.narratorPart).toBeLessThanOrEqual(NARRATOR_WEIGHT);
  });

  it("the pool's grades are C, C+, B- and A-: one step is worth a speaker's share", () => {
    const grades = new Set(CHARACTER_VOICES.filter((x) => x.wpm10 >= PACE_BAND[0] && x.wpm10 <= PACE_BAND[1] && GRADES.indexOf(x.grade as (typeof GRADES)[number]) >= GRADES.indexOf("C")).map((x) => x.grade));
    expect([...grades].sort()).toEqual(["A-", "B-", "C", "C+"]);
  });

  it("CAST_ENGINE_VERSION is defined exactly once in web/src, in its own module", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full);
        else if (/\.(ts|mts|js|mjs)$/.test(d.name)) files.push(full);
      }
    };
    walk(path.join(root, "web", "src"));
    const defs = files.flatMap((f) => (readFileSync(f, "utf8").match(/export const CAST_ENGINE_VERSION\b/g) ?? []).map(() => path.relative(root, f).split(path.sep).join("/")));
    expect(defs).toEqual(["web/src/engine/cast-version.ts"]);
    expect(CAST_ENGINE_VERSION).toBe("2");
    // The offline helper takes the version without the voice table.
    expect(readFileSync(path.join(root, "web/src/sw.ts"), "utf8")).toContain('from "./engine/cast-version"');
    expect(readFileSync(path.join(root, "web/src/engine/cast-version.ts"), "utf8")).not.toMatch(/^import /m);
  });
});

describe("a pool too small is reported, never hidden", () => {
  it("three men who all answer one another, and two American male voices: the third clashes, and the report says so", () => {
    const three = ["A", "B", "C"].map((speaker, i) => ({ speaker, words: 300 - i * 10 }));
    const turns = ["A", "B", "C", "A", "C", "B", "A"];
    const got = castVoices(three, { narrator: "m", speakers: { A: "m", B: "m", C: "m" } }, TABLE, turns);
    expect([got.get("A")!.voice, got.get("B")!.voice].sort()).toEqual(["am_fenrir", "am_puck"]);
    expect(got.get("C")!.reason.clash).toBe(true);
    expect(got.get("C")!.reason.sharedWith.length).toBe(1);
    const c = cast(segment("ALPHA: One.\n\nBETA: Two.\n\nGAMMA: Three.\n\nALPHA: Four.\n\nGAMMA: Five.\n\nBETA: Six."), { narrator: "m", speakers: { ALPHA: "m", BETA: "m", GAMMA: "m" } });
    const report = castReport(c);
    expect(report.parts.map((p) => p.clash)).toEqual([false, false, true]);
  });
});

describe("the catalogue's casts", () => {
  it("Crito, from the real text: Socrates is am_fenrir, Crito is am_puck, both American, with the score's parts", () => {
    const report = castReport(cast(segment(text("crito")), WORKS[1]!.cast));
    expect(report.narrator).toBe("am_michael");
    expect(report.parts).toEqual([
      { speaker: "SOCRATES", voice: "am_fenrir", words: 4154, quality: 7, share: 790, qualityPart: 5530, contrastPart: 0, narratorPart: 0, score: 5530, accent: "us", minor: false, sharedWith: [], clash: false },
      { speaker: "CRITO", voice: "am_puck", words: 1098, quality: 7, share: 209, qualityPart: 1463, contrastPart: 245, narratorPart: 0, score: 1708, accent: "us", minor: false, sharedWith: [], contrastRule: "met", clash: false },
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

describe("a voice no longer cast leaves the device", () => {
  it("the loader deletes cached voices this build does not pin, and nothing else", async () => {
    const { hfVoiceKey, unpinnedVoiceKeys } = await import("../web/src/voice-files");
    const repo = "onnx-community/Kokoro-82M-v1.0-ONNX";
    const pins = { am_michael: "x", am_puck: "y" };
    const keys = [hfVoiceKey(repo, "am_michael"), hfVoiceKey(repo, "bm_fable"), hfVoiceKey(repo, "bm_lewis"), hfVoiceKey(repo, "am_puck"), "https://example.invalid/other.bin", hfVoiceKey("other/repo", "bm_george")];
    expect(unpinnedVoiceKeys(keys, repo, pins)).toEqual([hfVoiceKey(repo, "bm_fable"), hfVoiceKey(repo, "bm_lewis")]);
    const voice = readFileSync(path.join(root, "web/src/voice.ts"), "utf8");
    expect(voice).toContain("for (const stale of unpinnedVoiceKeys((await voices.keys()).map((r) => r.url), manifest.repo, manifest.voices)) await voices.delete(stale);");
  });
});

describe("the page ships only what casting reads of the voice table", () => {
  it("the virtual module the build serves holds the projected fields and none of the table's others", async () => {
    const { CAST_FIELDS, projectVoices, voiceTable } = await import("../scripts/lib/voice-table.mjs");
    const plugin = voiceTable() as { resolveId(id: string): string | undefined; load(this: object, id: string): string | undefined };
    const resolved = plugin.resolveId("virtual:dial-voice-table")!;
    expect(resolved).toBeDefined();
    expect(plugin.resolveId("./other")).toBeUndefined();
    const code = plugin.load.call({}, resolved)!;
    expect(code.startsWith("export const voices = ")).toBe(true);
    const shipped = JSON.parse(code.slice("export const voices = ".length).trim().replace(/;$/, "")) as Record<string, unknown>[];
    for (const row of shipped) expect(Object.keys(row)).toEqual(CAST_FIELDS);
    expect(shipped.map((r) => r.id)).toEqual(TABLE.map((v) => v.id));
    const table = JSON.parse(readFileSync(path.join(root, "design/voices.json"), "utf8"));
    expect(shipped).toEqual(projectVoices(table));
    for (const unused of ["loudness_dbfs", "pause_to_speech", "render_rtf", "file_sha256", "provenance", "hexgrad", "training_duration"]) expect(code, unused).not.toContain(unused);
  });

  it("the built scripts, where built, agree (npm run build first: the gate builds before it tests)", () => {
    const assets = path.join(root, "dist", "assets");
    expect(existsSync(assets), "dist/assets is missing: run npm run build (the gate does) before this test").toBe(true);
    const js = readdirSync(assets).filter((f) => f.endsWith(".js")).map((f) => readFileSync(path.join(assets, f), "utf8")).join("\n");
    expect(js).toContain("wpm_as_played");
    for (const unused of ["loudness_dbfs", "pause_to_speech", "render_rtf", "measured_source_data", "training_duration"]) expect(js, unused).not.toContain(unused);
  });
});
