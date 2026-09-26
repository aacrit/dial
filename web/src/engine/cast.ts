// Casting without content (Law 3): each speaker the engine found gets a
// voice from a fixed palette, in the order the speakers first speak. Nothing
// is inferred from a name (not gender, age or character): the same text
// always gets the same cast, and a renamed speaker in the same place gets
// the same voice. Pure and deterministic.

import type { Cue } from "./segment";

/** The palette, in casting order: the 1st speaker, the 2nd, the 3rd; later speakers wrap around. */
export const PALETTE = ["bm_george", "bm_lewis", "bm_fable"] as const;
export type VoiceId = (typeof PALETTE)[number];

/** The narrator (every cue with no speaker) shares the first speaker's voice. */
export const NARRATOR_VOICE: VoiceId = PALETTE[0];

/** How the page names each voice (Kokoro's own names). */
export const VOICE_NAMES: Record<VoiceId, string> = { bm_george: "George", bm_lewis: "Lewis", bm_fable: "Fable" };

export interface Part {
  /** The label as printed ("SOCRATES"). */
  speaker: string;
  voice: VoiceId;
  /** Index of the cue where the speaker first speaks. */
  firstCue: number;
}

export interface Cast {
  /** Speakers in the order they first speak; empty for a work with no labels. */
  parts: Part[];
  /** Whether any cue has no speaker, so the narrator speaks it. */
  narrated: boolean;
  /** The voice for each cue, index for index. */
  voices: VoiceId[];
}

export function cast(cues: readonly Pick<Cue, "speaker">[]): Cast {
  const parts: Part[] = [];
  const bySpeaker = new Map<string, VoiceId>();
  let narrated = false;
  const voices = cues.map((c, i) => {
    if (c.speaker === undefined) {
      narrated = true;
      return NARRATOR_VOICE;
    }
    let voice = bySpeaker.get(c.speaker);
    if (!voice) {
      voice = PALETTE[parts.length % PALETTE.length]!;
      bySpeaker.set(c.speaker, voice);
      parts.push({ speaker: c.speaker, voice, firstCue: i });
    }
    return voice;
  });
  return { parts, narrated, voices };
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
