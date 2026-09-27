// The radio's HTML, as pure functions from the catalogue and the texts. Every
// value is escaped for its context (text and attributes alike), because the
// works' text arrives over the network and the catalogue will grow; nothing
// here writes a style attribute (the CSP forbids them).

import { grouped, isPublicDomainWorldwide, type Work } from "./catalogue";
import { DIAL, MAX_ANGLE, polar } from "./device/needle";
import { VOICE_NAMES, inOneAccent, speakerName, voiceCount, type Cast, type CastSheet } from "./engine/cast";

import { esc } from "./escape";

export { esc };

const num = (value: unknown) => `<span data-numeral>${esc(value)}</span>`;

/**
 * The station line's eyebrow: "about 20 min", once the text is read. The
 * catalogue number is not here: it appears only in the dial's readout and
 * the Bookplate (founder, 2026-09-26).
 */
export function eyebrowHtml(minutes?: number): string {
  return minutes ? `about ${num(minutes)} min` : "";
}

const COUNT_WORDS = ["", "One", "Two", "Three"];

/** "One voice", "Two voices": how many voices the cast gives the work (one until the text is read). */
export function voicesLabel(count: number): string {
  const n = COUNT_WORDS[count] ?? num(count);
  return `${n} voice${count === 1 ? "" : "s"}`;
}

/** The station card's facts line. The voice count comes from the cast. */
export function metaHtml(work: Work, words?: number, cast?: Pick<Cast, "voices">): string {
  const parts = [];
  if (words !== undefined) parts.push(`<span>${num(grouped(words))} words</span>`);
  if (cast) parts.push(`<span>${voicesLabel(voiceCount(cast))}</span>`);
  if (isPublicDomainWorldwide(work)) parts.push(`<span class="pd">Public domain worldwide</span>`);
  return parts.join("");
}

/**
 * The Voice row's first sentence, from the cast: "Socrates: Fenrir. Crito:
 * Puck." for a work whose speakers are labelled, "One voice, Michael, reads
 * every part." for one without labels. Nothing until the text is read.
 */
export function castSentence(cast?: Pick<Cast, "narrator" | "parts" | "narrated">): string {
  if (!cast) return "";
  const narrator = VOICE_NAMES[cast.narrator];
  if (cast.parts.length === 0) return `One voice, ${narrator}, reads every part. `;
  const lines = cast.parts.map((p) => `${esc(speakerName(p.speaker))}: ${VOICE_NAMES[p.voice]}.`);
  if (cast.narrated) lines.unshift(`The narration: ${narrator}.`);
  const how = inOneAccent(cast) ? "in one accent, by" : "by";
  return `${lines.join(" ")} Voices are cast ${how} the voice model's published grade and their measured contrast, never from the speakers' names. `;
}

const SEX_WORDS = { m: "male", f: "female" } as const;
const ACCENT_WORDS = { us: "American", uk: "British" } as const;

/** The curator's cast sheet, as the Bookplate shows it: "... asks only for voice sex: narrator male; Socrates male; Crito male." */
export function castSheetSentence(sheet?: CastSheet): string {
  if (!sheet) return "";
  const asks = [...(sheet.accent ? [`accent ${ACCENT_WORDS[sheet.accent]}`] : []), `narrator ${SEX_WORDS[sheet.narrator]}`, ...Object.entries(sheet.speakers ?? {}).map(([speaker, sex]) => `${esc(speakerName(speaker))} ${SEX_WORDS[sex]}`)];
  return `The curator's cast sheet, from the edition's list of persons, asks only for voice sex${sheet.accent ? " and accent" : ""}: ${asks.join("; ")}. `;
}

/** The Bookplate: station, source, public-domain basis, voice, direction, and a human reading where one is known. */
export function bookplateHtml(work: Work, cast?: Cast): string {
  const s = work.source;
  const rows: [string, string][] = [
    ["Station", `${num(`514 · ${work.station}`)} on the dial`],
    [
      "Source",
      `Project Gutenberg eBook No. ${num(s.ebook)}, <cite>${esc(s.book)}</cite>, translated by ${esc(work.translator)}. ` +
        `Performed from &ldquo;${esc(s.from)}&rdquo; to &ldquo;${esc(s.to)}&rdquo; ${esc(s.notPerformed)}`,
    ],
  ];
  if (isPublicDomainWorldwide(work)) {
    rows.push([
      "Public domain",
      `<span class="pd">Worldwide.</span> ${esc(work.pd.publishedAs)} ${num(work.pd.published)}; ` +
        `${esc(work.translator.split(" ").at(-1))} died in ${num(work.pd.translatorDied)}.`,
    ]);
  }
  rows.push([
    "Voice",
    `${castSentence(cast)}${castSheetSentence(work.cast)}The speech is made by Kokoro-82M, an open speech model that runs on your device. AI-voiced; the words are ${esc(work.translator.split(" ").at(-1))}'s, exactly as printed.`,
  ]);
  rows.push(["Direction", "Nobody directed this performance. The same fixed rules perform every work, from the layout of the text alone."]);
  if (work.librivox) {
    rows.push(["Also", `Prefer a human reader? <a href="${esc(work.librivox)}" rel="noopener">LibriVox has a volunteer reading of the same translation</a>.`]);
  }
  return rows.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${dd}</dd>`).join("");
}

/** The Bookplate sheet's heading line: "514 · No. 002 · Crito" (the Bookplate may carry the catalogue number). */
export function bookplateHeading(work: Pick<Work, "station" | "title">): string {
  return `514 · No. ${work.station} · ${work.title}`;
}

/** The dial scale: the arc, minor and major ticks every `step` degrees, and one long tick per station, labelled with the work's name. */
export function scaleSvg(works: readonly Work[], step: number, tuned: number): string {
  const f = (n: number) => n.toFixed(2);
  const [ax, ay] = polar(-MAX_ANGLE, DIAL.r);
  const [bx, by] = polar(MAX_ANGLE, DIAL.r);
  let out = `<path class="arc" d="M${f(ax)} ${f(ay)} A${DIAL.r} ${DIAL.r} 0 0 1 ${f(bx)} ${f(by)}"/>`;
  for (let a = -MAX_ANGLE; a <= MAX_ANGLE + 0.01; a += step) {
    const major = Math.abs(a % 10) < 0.01;
    const [x1, y1] = polar(a, DIAL.r);
    const [x2, y2] = polar(a, DIAL.r - (major ? 10 : 5));
    out += `<line class="tk${major ? " maj" : ""}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
  }
  works.forEach((w, i) => {
    const [x1, y1] = polar(w.angle, DIAL.r + 4);
    const [x2, y2] = polar(w.angle, DIAL.r - 16);
    const [lx, ly] = polar(w.angle, DIAL.r - 30);
    out += `<line class="tk st" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
    out += `<text class="lb${i === tuned ? " on" : ""}" x="${f(lx)}" y="${f(ly + 4)}" data-i="${i}">${esc(w.dial)}</text>`;
  });
  return out;
}

/** The station preset keys: each work's short name, and its title for assistive tech (no catalogue number). */
export function presetKeysHtml(works: readonly Work[], tuned: number): string {
  return works
    .map(
      (w, i) =>
        `<button class="key station" type="button" data-preset="${i}" aria-pressed="${i === tuned}" aria-label="${esc(w.title)}">` +
        `<span class="t">${esc(w.short)}</span></button>`,
    )
    .join("");
}

/** A read-along line: its words, and the speaker's name where the line opens a labelled turn. */
export interface ReadLine {
  text: string;
  speaker?: string;
}

/**
 * The read-along lines for a work's cues. A line that opens a labelled turn
 * shows the speaker's name, then the words after the label (verbatim, the
 * label moved into the name); every other line is its cue's text.
 */
export function readLines(cues: readonly { text: string; spoken: string; speaker?: string; speakerRule?: string }[]): ReadLine[] {
  return cues.map((c) => (c.speakerRule === "speaker-label" && c.speaker ? { text: c.spoken, speaker: speakerName(c.speaker) } : { text: c.text }));
}

/** The read-along strip: the previous line, the live line and the next one, each with its speaker's name where it opens a turn. */
export function readAlongHtml(lines: readonly ReadLine[], live: number): string {
  const line = (i: number, cls: string) => {
    const l = i >= 0 && i < lines.length ? lines[i]! : null;
    const who = l?.speaker ? `<span class="ra-sp">${esc(l.speaker)}</span> ` : "";
    return `<p class="ra ${cls}">${l ? who + esc(l.text) : ""}</p>`;
  };
  return line(live - 1, "prev") + line(live, "live") + line(live + 1, "next");
}

// ---- The Broadcast: the full script, the progress strip, the shortcuts -----

/**
 * The full script: every cue's text exactly as printed (Law 2). Between two
 * lines goes exactly what the source has between them: nothing, a space
 * where it has whitespace, or a new paragraph where it has a blank line.
 * Each line is a control that plays from it once it is made; the live line
 * carries the amber treatment. One line holds the tab stop (the live one,
 * else the first): the arrow keys move it (a roving tabindex, main.ts).
 */
export function scriptHtml(source: string, cues: readonly { start: number; end: number; text: string }[], live: number, made: number): string {
  const stop = live >= 0 && live < cues.length ? live : 0;
  let out = "<p>";
  cues.forEach((c, i) => {
    const cls = `sl${i === live ? " live" : ""}${i >= made ? " unmade" : ""}`;
    const state = i >= made ? ` aria-disabled="true"` : "";
    const current = i === live ? ` aria-current="true"` : "";
    out += `<span class="${cls}" role="button" tabindex="${i === stop ? 0 : -1}" data-i="${i}"${state}${current}>${esc(c.text)}</span>`;
    const next = cues[i + 1];
    if (!next) return;
    const gap = source.slice(c.end, next.start);
    // A paragraph break is a block and a text node too: "\n\n" between the
    // paragraphs keeps the words apart in textContent (copy, screen readers).
    if (/\n[^\S\n]*\n/.test(gap)) out += "</p>\n\n<p>";
    else if (/\s/.test(gap)) out += " ";
  });
  return `${out}</p>`;
}

/** The shortcuts sheet's list: each key as a keycap, then what it does. */
export function shortcutsHtml(rows: readonly (readonly [readonly string[], string])[]): string {
  return rows.map(([keys, what]) => `<dt>${keys.map((k) => `<kbd class="keycap">${esc(k)}</kbd>`).join("")}</dt><dd>${esc(what)}</dd>`).join("");
}

/**
 * The progress strip: one segment per line along the running time, in the
 * work's realm colour: heard solid, made but ahead faded, not yet made as a
 * ghost. Lengths are real for made lines and estimated for the rest.
 */
export function ribbonSvg(lengths: readonly number[], total: number, made: number, heard: number): string {
  const W = 1000;
  let at = 0;
  let out = "";
  lengths.forEach((d, i) => {
    const x = total > 0 ? (at / total) * W : 0;
    const w = total > 0 ? Math.max(0.8, (d / total) * W - 0.6) : 0;
    const cls = i >= made ? "seg unmade" : i > heard ? "seg ahead" : "seg";
    out += `<rect class="${cls}" x="${x.toFixed(1)}" y="9" width="${w.toFixed(1)}" height="12" rx="1"/>`;
    at += d;
  });
  return out;
}
