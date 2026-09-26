// Casting without content (Law 3). Two roles, kept apart:
//
// - The narrator reads every cue with no speaker (unlabelled or telling
//   text). Dial has two fixed narrator voices across all works, one female
//   and one male (founder, 2026-09-27); a work's cast sheet picks which.
// - Each speaker the engine found gets a character voice from the palette,
//   which never contains a narrator voice.
//
// Nothing is inferred from a name (not sex, age or character): the same
// text always gets the same cast, and a renamed speaker in the same place
// gets the same voice. The one outside input is a Repertory work's cast
// sheet, which the curator writes from the edition's list of persons and
// which declares only voice sex; the engine honours it and never parses
// names. Pure and deterministic.
//
// castVoices() is the casting rule, kept apart so it can be replaced: for
// now each speaker, in order of first appearance, takes the next palette
// voice, skipping voices of the wrong sex where the sheet declares one. T2c
// replaces it with quality and contrast scoring; its inputs (speakers in
// order with their word counts, the sheet, the palette) stay.

import type { Cue } from "./segment";

/** A voice's sex, as its model publishes it, and as a cast sheet declares it. */
export type VoiceSex = "m" | "f";

/**
 * The two narrator voices. The female is af_heart; the male is a placeholder
 * (bm_george, the voice every work used before casting) until one is chosen
 * by ear.
 */
export const NARRATORS = { m: "bm_george", f: "af_heart" } as const;

/**
 * The character palette, in casting order: Kokoro's British English male
 * voices other than the narrator, best overall grade first (Fable C, Lewis
 * D+, from kokoro-js's voice table).
 */
export const PALETTE = ["bm_fable", "bm_lewis"] as const;

export type NarratorVoiceId = (typeof NARRATORS)[VoiceSex];
export type VoiceId = NarratorVoiceId | (typeof PALETTE)[number];

/** Every voice the cast can use: the files fetch-voice.mjs stages and pins. */
export const ALL_VOICES: readonly VoiceId[] = [NARRATORS.m, NARRATORS.f, ...PALETTE];

export interface Voice<Id extends string = VoiceId> {
  id: Id;
  sex: VoiceSex;
}

/** The palette with each voice's sex (kokoro-js: bm_ is British English, male). */
export const PALETTE_VOICES: readonly Voice[] = [
  { id: "bm_fable", sex: "m" },
  { id: "bm_lewis", sex: "m" },
];

/** How the page names each voice (Kokoro's own names). */
export const VOICE_NAMES: Record<VoiceId, string> = { bm_george: "George", af_heart: "Heart", bm_fable: "Fable", bm_lewis: "Lewis" };

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

const NARRATOR_IDS: readonly string[] = Object.values(NARRATORS);

/** The narrator's voice: the sheet's choice, else the male narrator. */
export function narratorVoice(sheet?: Pick<CastSheet, "narrator">): NarratorVoiceId {
  return NARRATORS[sheet?.narrator ?? "m"];
}

/**
 * Assigns each speaker a character voice. `speakers` come in order of first
 * appearance. Narrator voices are never used, whatever the palette holds.
 * Speaker i prefers the i-th remaining voice (wrapping); where the sheet
 * declares a sex, it takes the first voice of that sex from there on. A
 * sheet no palette voice can honour is an error, never a silent wrong voice.
 */
export function castVoices<Id extends string>(speakers: readonly SpeakerStats[], sheet: CastSheet | undefined, palette: readonly Voice<Id>[]): Map<string, Id> {
  const pool = palette.filter((v) => !NARRATOR_IDS.includes(v.id));
  const declared = sheet?.speakers ?? {};
  const out = new Map<string, Id>();
  speakers.forEach((s, i) => {
    const sex = Object.hasOwn(declared, s.speaker) ? declared[s.speaker] : undefined;
    for (let k = 0; k < pool.length; k++) {
      const v = pool[(i + k) % pool.length]!;
      if (sex === undefined || v.sex === sex) {
        out.set(s.speaker, v.id);
        return;
      }
    }
    throw new Error(`cast: no character voice in the palette for ${s.speaker}${sex ? ` (declared ${sex})` : ""}`);
  });
  return out;
}

export interface Part {
  /** The label as printed ("SOCRATES"). */
  speaker: string;
  voice: VoiceId;
  /** Index of the cue where the speaker first speaks. */
  firstCue: number;
  /** Words the speaker speaks in the work. */
  words: number;
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

/** The work's cast: the narrator from the sheet, and its speakers in order of first appearance, voiced by castVoices(). */
export function cast(cues: readonly Pick<Cue, "speaker" | "spoken">[], sheet?: CastSheet): Cast {
  const stats: SpeakerStats[] = [];
  const firstCue = new Map<string, number>();
  cues.forEach((c, i) => {
    if (c.speaker === undefined) return;
    let s = stats.find((x) => x.speaker === c.speaker);
    if (!s) {
      s = { speaker: c.speaker, words: 0 };
      stats.push(s);
      firstCue.set(c.speaker, i);
    }
    s.words += wordsIn(c.spoken);
  });
  const narrator = narratorVoice(sheet);
  const byVoice = castVoices(stats, sheet, PALETTE_VOICES);
  const parts = stats.map((s) => ({ speaker: s.speaker, voice: byVoice.get(s.speaker)!, firstCue: firstCue.get(s.speaker)!, words: s.words }));
  const narrated = cues.some((c) => c.speaker === undefined);
  const voices = cues.map((c) => (c.speaker === undefined ? narrator : byVoice.get(c.speaker)!));
  return { narrator, parts, narrated, voices };
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
