// The Repertory's three stations: what each work is, where its words come
// from and why it is public domain worldwide. Every field here is printed on
// the page, so every one is a claim that must be true:
//
// - The texts are web/public/works/<slug>.txt, pinned by SHA-256 with their
//   Gutenberg line ranges in tests/verbatim.test.ts (made by
//   scripts/extract-work.mjs).
// - Word counts and running times are never typed here: countWords() and
//   aboutMinutes() compute them from the text the page fetched.
// - Public domain worldwide means published before 1930 and the translator
//   died before 1956 (CLAUDE.md). Years checked 2026-09-26 against the
//   English Wikipedia articles "Benjamin Jowett" (died 1 October 1893; The
//   Dialogues of Plato published 1871) and "George Long (scholar)" (died
//   10 August 1879; his Meditations first published 1862).
// - No work has a recording Dial made in advance yet (prepared recordings
//   come with T5), so every one is made on the listener's device.

import type { Cue } from "./engine/segment";

export interface Work {
  /** File name under /works/ and the realm colour's name. */
  slug: "cave" | "crito" | "meditations";
  /** Station on the dial: "514 · <station>". */
  station: string;
  /** The needle's angle on the dial scale, in degrees (0 is straight up). */
  angle: number;
  title: string;
  /** The preset key's short name. */
  short: string;
  author: string;
  translator: string;
  /** The credit line under the title. */
  credit: string;
  /** The one-sentence description on the station card. */
  sentence: string;
  source: {
    ebook: number;
    /** The Gutenberg book's title. */
    book: string;
    /** First and last words performed. */
    from: string;
    to: string;
    /** What in the book is not performed, in plain words. */
    notPerformed: string;
  };
  pd: {
    published: number;
    /** How the Bookplate introduces the year: "Published 1871", "First published 1862". */
    publishedAs: "Published" | "First published";
    translatorDied: number;
  };
  /** False until a recording Dial made in advance exists (T5). */
  preparedRecording: boolean;
  /** A volunteer human reading of the same translation, where one is known. */
  librivox?: string;
}

export const WORKS: readonly Work[] = [
  {
    slug: "cave",
    station: "001",
    angle: -44,
    title: "The Allegory of the Cave",
    short: "The Cave",
    author: "Plato",
    translator: "Benjamin Jowett",
    credit: "Plato, Republic, Book VII, 514a to 521b. Translated by Benjamin Jowett.",
    sentence: "Prisoners in the dark take shadows for the world. One of them is turned toward the light.",
    source: {
      ebook: 1497,
      book: "The Republic",
      from: "And now, I said",
      to: "I will choose them, he replied.",
      notPerformed: "Jowett's introduction and the rest of the Republic are not performed.",
    },
    pd: { published: 1871, publishedAs: "Published", translatorDied: 1893 },
    preparedRecording: false,
    librivox: "https://librivox.org/platos_republic/",
  },
  {
    slug: "crito",
    station: "002",
    angle: -8,
    title: "Crito",
    short: "Crito",
    author: "Plato",
    translator: "Benjamin Jowett",
    credit: "Plato. Translated by Benjamin Jowett.",
    sentence: "Socrates in prison before dawn. His friend has a plan for escape. The Laws of Athens answer him.",
    source: {
      ebook: 1657,
      book: "Crito",
      from: "Why have you come at this hour, Crito?",
      to: "whither he leads.",
      notPerformed: "Jowett's introduction is not performed.",
    },
    pd: { published: 1871, publishedAs: "Published", translatorDied: 1893 },
    preparedRecording: false,
  },
  {
    slug: "meditations",
    station: "003",
    angle: 26,
    title: "Meditations, Book II",
    short: "Meditations",
    author: "Marcus Aurelius",
    translator: "George Long",
    credit: "Marcus Aurelius. Translated by George Long.",
    sentence: "An emperor's notes to himself, written on campaign by the Danube. Seventeen short sections, each followed by a silence.",
    source: {
      ebook: 15877,
      book: "Thoughts of Marcus Aurelius Antoninus",
      from: "Begin the morning by saying to thyself",
      to: "This in Carnuntum.",
      notPerformed: "Long's footnotes and his + marks for a doubtful reading are not performed; the words he supplied in brackets are.",
    },
    pd: { published: 1862, publishedAs: "First published", translatorDied: 1879 },
    preparedRecording: false,
  },
];

/** The rule the Repertory holds every work to (CLAUDE.md). */
export function isPublicDomainWorldwide(w: Pick<Work, "pd">): boolean {
  return w.pd.published < 1930 && w.pd.translatorDied < 1956;
}

/** Words as a reader counts them: runs of non-space characters. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Listening pace for the estimate (design/spec.md 2: 155 words a minute plus the pause table). */
export const WORDS_PER_MINUTE = 155;

/** Estimated running time in whole minutes: the words at 155 a minute plus every cue's pause. */
export function aboutMinutes(text: string, cues: readonly Pick<Cue, "pauseAfterMs">[]): number {
  const speechMs = (countWords(text) / WORDS_PER_MINUTE) * 60_000;
  const pauseMs = cues.reduce((sum, c) => sum + c.pauseAfterMs, 0);
  return Math.max(1, Math.round((speechMs + pauseMs) / 60_000));
}

/** "2,990": grouped the way the spec prints counts. */
export function grouped(n: number): string {
  return n.toLocaleString("en-GB");
}
