// Casting without content (Law 3). Two roles, kept apart:
//
// - The narrator reads every cue with no speaker (unlabelled or telling
//   text). Dial has two fixed narrator voices across all works, am_michael
//   (male) and af_heart (female), both chosen by the founder by ear
//   (2026-09-27); a work's cast sheet picks which.
// - Each speaker the engine found is cast a character voice from the
//   measured voice table (design/voices.json), which never offers a
//   narrator voice.
//
// Nothing is inferred from a name (not sex, age or character): the same
// text always gets the same cast, and a renamed speaker in the same place
// gets the same voice. The one outside input is a Repertory work's cast
// sheet, which the curator writes from the edition's list of persons and
// which declares only voice sex; the engine honours it and never parses
// names. Voices are never sped up or slowed down: pace is chosen here, by
// which voice is cast, and nowhere else. Pure and deterministic, integer
// maths only once the table is read.
//
// The algorithm (castVoices):
// 1. The pool: every English voice in the table except the two narrators,
//    graded C- or better (hexgrad's grade), whose natural pace as played is
//    150 to 215 wpm, and of the sex the sheet declares for the speaker. D+
//    voices join only when a declared sex would otherwise have none.
// 2. Speakers are ranked by word share (ties: first appearance). Each takes
//    the unused pool voice with the highest score:
//      quality(grade) x share
//      + sum over speakers already cast: alternation x contrast(voice, theirs)
//      + contrast(voice, narrator) x NARRATOR_WEIGHT.
//    alternation counts direct turn exchanges between two speakers;
//    contrast is a per-mille distance over accent, pitch, timbre and pace.
// 3. The pair that alternates most must differ by MIN_F0_CENTS of pitch or
//    by accent; if no voice can, the best is taken and the reason says so.
// 4. When the fitting voices run out, a speaker shares a voice with speakers
//    it never directly alternates with (greedy colouring of the alternation
//    graph, in rank order). Minor parts (under 2% of the words) are the
//    expected sharers. Sharing never reaches below the grade filter.

import { voices as MEASURED } from "../../../design/voices.json";
import type { Cue } from "./segment";

/**
 * The casting rule's version. Bump it whenever a change here can give a work
 * a different set of voices (a new narrator, a new palette, a new scoring
 * rule): works saved for offline under another version are then shown as
 * "Saved on an older version" (offline/routes.ts offlineKey) until the
 * listener reopens Dial with a connection.
 */
export const CAST_ENGINE_VERSION = "1";

/** A voice's sex, as its model publishes it, and as a cast sheet declares it. */
export type VoiceSex = "m" | "f";

/** The two narrator voices, chosen by the founder by ear (2026-09-27). */
export const NARRATORS = { m: "am_michael", f: "af_heart" } as const;

export type NarratorVoiceId = (typeof NARRATORS)[VoiceSex];
/** A Kokoro voice id ("bm_fable"); only ids in design/voices.json are ever cast. */
export type VoiceId = string;

/** A voice as casting reads it: design/voices.json's measurements, as integers. */
export interface Voice<Id extends string = VoiceId> {
  id: Id;
  sex: VoiceSex;
  /** "us" or "uk". */
  accent: string;
  /** hexgrad's overall grade ("C+"). */
  grade: string;
  /** Natural pace as a listener hears it in Dial, in tenths of a word per minute. */
  wpm10: number;
  /** Median F0, in cents above 55 Hz (a log scale: equal steps sound equal). */
  f0Cents: number;
  /** Mean spectral centroid, in Hz (timbre: brightness). */
  centroidHz: number;
}

/** 55 Hz, the reference for cents: below any speaking voice's median F0. */
const CENTS_REF_HZ = 55;

/** One table row, rounded once to integers; everything after is integer maths. */
export function measured<Id extends string>(row: { id: Id; sex: string; accent: string; hexgrad: { grade: string }; wpm_as_played: number; median_f0_hz: number; spectral_centroid_hz: number }): Voice<Id> {
  return {
    id: row.id,
    sex: row.sex === "f" ? "f" : "m",
    accent: row.accent,
    grade: row.hexgrad.grade,
    wpm10: Math.round(row.wpm_as_played * 10),
    f0Cents: Math.round(1200 * Math.log2(row.median_f0_hz / CENTS_REF_HZ)),
    centroidHz: Math.round(row.spectral_centroid_hz),
  };
}

/** Every English voice in the measured table, narrators included. */
export const TABLE: readonly Voice[] = MEASURED.map((row) => measured(row));

const NARRATOR_IDS: readonly string[] = Object.values(NARRATORS);

/** The voices characters may be cast from, before the per-work filters: the table without the narrators. */
export const CHARACTER_VOICES: readonly Voice[] = TABLE.filter((v) => !NARRATOR_IDS.includes(v.id));

/** "bm_fable" as the page names it: "Fable" (Kokoro's own name). */
export function voiceName(id: string): string {
  const name = id.slice(id.indexOf("_") + 1);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** How the page names each voice. */
export const VOICE_NAMES: Readonly<Record<string, string>> = Object.fromEntries(TABLE.map((v) => [v.id, voiceName(v.id)]));

// ---- the rules' constants ----------------------------------------------------

/** hexgrad's grades, worst to best; quality(grade) is the index. */
export const GRADES = ["F", "F+", "D-", "D", "D+", "C-", "C", "C+", "B-", "B", "B+", "A-", "A", "A+"] as const;
/** The lowest grade a character is cast from: the C band. hexgrad's D voices glitch on long sentences. */
export const MIN_GRADE = "C-";
/** The fallback grade, used only when a declared sex has no voice at MIN_GRADE or better. */
export const FALLBACK_GRADE = "D+";
/**
 * The pace band, as played, in tenths of a wpm. Below 150 a voice drags
 * against the others (af_nicole, 121); above 215 it hurries past the
 * listener. Voices are never re-timed to fit: a voice outside is not cast.
 */
export const PACE_BAND = [1500, 2150] as const;
/** A part under this share of the words (per mille) is minor: 2%. */
export const MINOR_PERMILLE = 20;

/**
 * contrast() weights, out of CONTRAST_WEIGHT_SUM. Pitch leads: it is the cue
 * listeners use most to tell two voices apart in quick exchange. Accent is
 * categorical and heard at once, so it is next. Timbre (spectral centroid)
 * separates voices of the same pitch less reliably. Pace counts least: the
 * band already keeps it narrow, and a pace jump between alternating
 * speakers reads as unevenness more than as character.
 */
export const CONTRAST_WEIGHTS = { f0: 4, accent: 3, centroid: 2, pace: 1 } as const;
const CONTRAST_WEIGHT_SUM = CONTRAST_WEIGHTS.f0 + CONTRAST_WEIGHTS.accent + CONTRAST_WEIGHTS.centroid + CONTRAST_WEIGHTS.pace;
/** Each difference is saturated at a span: past an octave of pitch, 800 Hz of centroid or 40 wpm, voices are simply different. */
export const CONTRAST_SPANS = { f0Cents: 1200, centroidHz: 800, wpm10: 400 } as const;
/**
 * The weight of a voice's contrast with the narrator, in the same units as
 * one turn exchange: characters should not sound like the house narrator,
 * whom the listener hears across the whole catalogue, but in a narrated work
 * the exchanges with other speakers matter more.
 */
export const NARRATOR_WEIGHT = 1;
/** The most-alternating pair must differ by at least this much pitch (two semitones) or by accent. */
export const MIN_F0_CENTS = 200;

const gradeOf = (g: string) => GRADES.indexOf(g as (typeof GRADES)[number]);

/** Contrast between two voices, 0 (the same) to 1000 (far apart on every axis), integers only. */
export function contrast(a: Voice<string>, b: Voice<string>): number {
  const part = (d: number, span: number) => Math.floor((Math.min(Math.abs(d), span) * 1000) / span);
  const sum =
    CONTRAST_WEIGHTS.accent * (a.accent === b.accent ? 0 : 1000) +
    CONTRAST_WEIGHTS.f0 * part(a.f0Cents - b.f0Cents, CONTRAST_SPANS.f0Cents) +
    CONTRAST_WEIGHTS.centroid * part(a.centroidHz - b.centroidHz, CONTRAST_SPANS.centroidHz) +
    CONTRAST_WEIGHTS.pace * part(a.wpm10 - b.wpm10, CONTRAST_SPANS.wpm10);
  return Math.floor(sum / CONTRAST_WEIGHT_SUM);
}

/** Whether two voices are far enough apart for the most-alternating pair. */
export function distinct(a: Voice<string>, b: Voice<string>): boolean {
  return a.accent !== b.accent || Math.abs(a.f0Cents - b.f0Cents) >= MIN_F0_CENTS;
}

const inPace = (v: Voice<string>) => v.wpm10 >= PACE_BAND[0] && v.wpm10 <= PACE_BAND[1];

/**
 * A curator's cast sheet: the narrator's voice sex, and each labelled
 * speaker (as printed) with only its voice sex.
 */
export interface CastSheet {
  narrator: VoiceSex;
  speakers?: Readonly<Record<string, VoiceSex>>;
}

/** A speaker as the engine found it: the label, and how many words the speaker speaks. */
export interface SpeakerStats {
  speaker: string;
  words: number;
}

/** Why a speaker got its voice: the score's parts, for the Direction report. */
export interface CastReason {
  /** quality(grade): the index in GRADES. */
  quality: number;
  /** The speaker's share of all spoken words, per mille. */
  share: number;
  qualityPart: number;
  /** Sum over speakers already cast of alternation x contrast. */
  contrastPart: number;
  narratorPart: number;
  score: number;
  /** Under MINOR_PERMILLE of the words. */
  minor: boolean;
  /** Speakers cast earlier who hold the same voice (sharing, rule 4). */
  sharedWith: string[];
  /** Set on the later member of the most-alternating pair: whether MIN_F0_CENTS or accent separates them. */
  contrastRule?: "met" | "unmet";
  /** Set when no fitting voice was free of speakers this one alternates with. */
  clash?: boolean;
}

export interface Casting<Id extends string = VoiceId> {
  voice: Id;
  reason: CastReason;
}

/** The narrator's voice: the sheet's choice, else the male narrator. */
export function narratorVoice(sheet?: Pick<CastSheet, "narrator">): NarratorVoiceId {
  return NARRATORS[sheet?.narrator ?? "m"];
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/**
 * Direct turn exchanges between each pair of speakers: `turns` is the
 * speaker of each labelled cue, in order (narration left out, so a narrator's
 * "he said" between two lines does not hide the exchange).
 */
export function alternations(turns: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1]!;
    const b = turns[i]!;
    if (a === b) continue;
    const k = pairKey(a, b);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/**
 * Casts each speaker a character voice (the algorithm is in the header).
 * `speakers` come in order of first appearance, with their word counts;
 * `turns` is the speaker of each labelled cue in order. Narrator voices are
 * never cast, whatever the palette holds. A sheet the pool cannot honour
 * (no voice of a declared sex) throws, never a silent wrong voice.
 */
export function castVoices<Id extends string>(
  speakers: readonly SpeakerStats[],
  sheet: CastSheet | undefined,
  palette: readonly Voice<Id>[] = CHARACTER_VOICES as readonly Voice<Id>[],
  turns: readonly string[] = [],
): Map<string, Casting<Id>> {
  const narrator = TABLE.find((v) => v.id === narratorVoice(sheet))!;
  const declared = sheet?.speakers ?? {};
  const candidates = palette.filter((v) => !NARRATOR_IDS.includes(v.id) && inPace(v));
  const graded = (min: string) => candidates.filter((v) => gradeOf(v.grade) >= gradeOf(min));
  const main = graded(MIN_GRADE);
  const fallback = graded(FALLBACK_GRADE);
  const poolFor = (sex: VoiceSex | undefined) => {
    if (sex === undefined) return main;
    const own = main.filter((v) => v.sex === sex);
    return own.length > 0 ? own : fallback.filter((v) => v.sex === sex);
  };

  const alt = alternations(turns);
  const altOf = (a: string, b: string) => alt.get(pairKey(a, b)) ?? 0;
  const total = speakers.reduce((n, s) => n + s.words, 0);
  const shareOf = (s: SpeakerStats) => (total === 0 ? 0 : Math.floor((s.words * 1000) / total));

  // Rank by word share; Array.prototype.sort is stable, so ties keep first appearance.
  const ranked = [...speakers].sort((a, b) => b.words - a.words);

  // The pair that alternates most (ties: the pair whose members rank first).
  let top: [string, string] | undefined;
  let topAlt = 0;
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const n = altOf(ranked[i]!.speaker, ranked[j]!.speaker);
      if (n > topAlt) {
        topAlt = n;
        top = [ranked[i]!.speaker, ranked[j]!.speaker];
      }
    }
  }

  const out = new Map<string, Casting<Id>>();
  const holders = new Map<Id, string[]>();
  for (const s of ranked) {
    const sex = Object.hasOwn(declared, s.speaker) ? declared[s.speaker] : undefined;
    const pool = poolFor(sex);
    if (pool.length === 0) throw new Error(`cast: no character voice in the palette for ${s.speaker}${sex ? ` (declared ${sex})` : ""}`);
    const share = shareOf(s);

    const score = (v: Voice<Id>): CastReason => {
      const quality = gradeOf(v.grade);
      let contrastPart = 0;
      for (const [other, c] of out) {
        const n = altOf(s.speaker, other);
        if (n > 0) contrastPart += n * contrast(v, palette.find((p) => p.id === c.voice)!);
      }
      const narratorPart = contrast(v, narrator) * NARRATOR_WEIGHT;
      const qualityPart = quality * share;
      return { quality, share, qualityPart, contrastPart, narratorPart, score: qualityPart + contrastPart + narratorPart, minor: share < MINOR_PERMILLE, sharedWith: [] };
    };

    const free = pool.filter((v) => !holders.has(v.id));
    // Sharing: only voices none of whose holders this speaker alternates with.
    const shareable = pool.filter((v) => (holders.get(v.id) ?? []).every((h) => altOf(s.speaker, h) === 0));
    let options = free.length > 0 ? free : shareable.length > 0 ? shareable : pool;
    const clash = free.length === 0 && shareable.length === 0;

    // Rule 3: the later member of the most-alternating pair.
    let contrastRule: CastReason["contrastRule"];
    if (top && top.includes(s.speaker) && out.has(top[0] === s.speaker ? top[1] : top[0])) {
      const partner = palette.find((p) => p.id === out.get(top![0] === s.speaker ? top![1] : top![0])!.voice)!;
      const apart = options.filter((v) => distinct(v, partner));
      contrastRule = apart.length > 0 ? "met" : "unmet";
      if (apart.length > 0) options = apart;
    }

    let best: Voice<Id> | undefined;
    let bestReason: CastReason | undefined;
    for (const v of options) {
      const r = score(v);
      if (!bestReason || r.score > bestReason.score || (r.score === bestReason.score && v.id < best!.id)) {
        best = v;
        bestReason = r;
      }
    }
    const reason: CastReason = { ...bestReason!, sharedWith: [...(holders.get(best!.id) ?? [])] };
    if (contrastRule) reason.contrastRule = contrastRule;
    if (clash) reason.clash = true;
    out.set(s.speaker, { voice: best!.id, reason });
    holders.set(best!.id, [...(holders.get(best!.id) ?? []), s.speaker]);
  }
  // Report in order of first appearance, as the speakers came in.
  return new Map(speakers.map((s) => [s.speaker, out.get(s.speaker)!]));
}

export interface Part {
  /** The label as printed ("SOCRATES"). */
  speaker: string;
  voice: VoiceId;
  /** Index of the cue where the speaker first speaks. */
  firstCue: number;
  /** Words the speaker speaks in the work. */
  words: number;
  /** Why this voice: the score's parts (castReport()). */
  reason: CastReason;
}

export interface Cast {
  /** The narrator's voice, for every cue with no speaker. */
  narrator: NarratorVoiceId;
  /** Speakers in the order they first speak; empty for a work with no labels. */
  parts: Part[];
  /** Whether any cue has no speaker, so the narrator speaks it. */
  narrated: boolean;
  /** The voice for each cue, index for index. */
  voices: VoiceId[];
}

const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** The work's cast: the narrator from the sheet, and its speakers voiced by castVoices() from `palette` (the table, by default). */
export function cast(cues: readonly Pick<Cue, "speaker" | "spoken">[], sheet?: CastSheet, palette: readonly Voice[] = CHARACTER_VOICES): Cast {
  const stats: SpeakerStats[] = [];
  const firstCue = new Map<string, number>();
  const turns: string[] = [];
  cues.forEach((c, i) => {
    if (c.speaker === undefined) return;
    turns.push(c.speaker);
    let s = stats.find((x) => x.speaker === c.speaker);
    if (!s) {
      s = { speaker: c.speaker, words: 0 };
      stats.push(s);
      firstCue.set(c.speaker, i);
    }
    s.words += wordsIn(c.spoken);
  });
  const narrator = narratorVoice(sheet);
  const byVoice = castVoices(stats, sheet, palette, turns);
  const parts = stats.map((s) => {
    const c = byVoice.get(s.speaker)!;
    return { speaker: s.speaker, voice: c.voice, firstCue: firstCue.get(s.speaker)!, words: s.words, reason: c.reason };
  });
  const narrated = cues.some((c) => c.speaker === undefined);
  const voices = cues.map((c) => (c.speaker === undefined ? narrator : byVoice.get(c.speaker)!.voice));
  return { narrator, parts, narrated, voices };
}

/** The work's cast, or null when its sheet cannot be honoured: that station alone is then unavailable. */
export function tryCast(cues: readonly Pick<Cue, "speaker" | "spoken">[], sheet?: CastSheet, palette: readonly Voice[] = CHARACTER_VOICES): Cast | null {
  try {
    return cast(cues, sheet, palette);
  } catch {
    return null;
  }
}

/** One line of the casting report: who, which voice, and the score's parts. */
export interface CastReportRow extends CastReason {
  speaker: string;
  voice: VoiceId;
  words: number;
}

/**
 * The casting, explained, for the future Direction report: the narrator,
 * then each speaker in order of first appearance with the score's parts.
 */
export function castReport(c: Pick<Cast, "narrator" | "parts">): { narrator: NarratorVoiceId; parts: CastReportRow[] } {
  return { narrator: c.narrator, parts: c.parts.map((p) => ({ speaker: p.speaker, voice: p.voice, words: p.words, ...p.reason })) };
}

/** How many different voices the listener hears. */
export function voiceCount(c: Pick<Cast, "voices">): number {
  return new Set(c.voices).size;
}

/** "SOCRATES" as the page prints it: "Socrates" (each word capitalised; the form only). */
export function speakerName(label: string): string {
  return label
    .split(" ")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}
