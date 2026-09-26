// The radio's HTML, as pure functions from the catalogue and the texts. Every
// value is escaped for its context (text and attributes alike), because the
// works' text arrives over the network and the catalogue will grow; nothing
// here writes a style attribute (the CSP forbids them).

import { grouped, isPublicDomainWorldwide, type Work } from "./catalogue";
import { DIAL, MAX_ANGLE, polar } from "./device/needle";

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for an HTML text node or a quoted attribute value. */
export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch]!);
}

const num = (value: unknown) => `<span data-numeral>${esc(value)}</span>`;

/** "514 · No. 001 · about 20 min" (the minutes once the text is read). */
export function eyebrowHtml(work: Work, minutes?: number): string {
  const time = minutes ? ` · about ${num(minutes)} min` : "";
  return `${num(`514 · No. ${work.station}`)}${time}`;
}

/** The station card's facts line. Voices: the in-tab render reads every part in one voice until casting exists. */
export function metaHtml(work: Work, words?: number): string {
  const parts = [];
  if (words !== undefined) parts.push(`<span>${num(grouped(words))} words</span>`);
  parts.push(`<span>One voice</span>`);
  if (isPublicDomainWorldwide(work)) parts.push(`<span class="pd">Public domain worldwide</span>`);
  return parts.join("");
}

/** The Bookplate: source, public-domain basis, voice, direction, and a human reading where one is known. */
export function bookplateHtml(work: Work, speakerLabels = false): string {
  const s = work.source;
  const rows: [string, string][] = [
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
    `One voice, George, reads every part.${speakerLabels ? " Speaker names are read aloud until each part has its own voice." : ""} It is Kokoro-82M, an open speech model that runs on your device. AI-voiced; the words are ${esc(work.translator.split(" ").at(-1))}'s, exactly as printed.`,
  ]);
  rows.push(["Direction", "Nobody directed this performance. The same fixed rules perform every work, from the layout of the text alone."]);
  if (work.librivox) {
    rows.push(["Also", `Prefer a human reader? <a href="${esc(work.librivox)}" rel="noopener">LibriVox has a volunteer reading of the same translation</a>.`]);
  }
  return rows.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${dd}</dd>`).join("");
}

/** The dial scale: the arc, minor and major ticks every `step` degrees, and one long, labelled tick per station. */
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
    out += `<text class="lb${i === tuned ? " on" : ""}" x="${f(lx)}" y="${f(ly + 4)}" data-i="${i}">${esc(w.station)}</text>`;
  });
  return out;
}

/** The station preset keys: 001, 002, 003, each with its short name. */
export function presetKeysHtml(works: readonly Work[], tuned: number): string {
  return works
    .map(
      (w, i) =>
        `<button class="key station" type="button" data-preset="${i}" aria-pressed="${i === tuned}" aria-label="${esc(`Station ${w.station}, ${w.title}`)}">` +
        `<span data-numeral>${esc(w.station)}</span><span class="t">${esc(w.short)}</span></button>`,
    )
    .join("");
}

/** The read-along strip: the previous line, the live line and the next one (text only, verbatim). */
export function readAlongHtml(lines: readonly string[], live: number): string {
  const line = (i: number, cls: string) => `<p class="ra ${cls}">${i >= 0 && i < lines.length ? esc(lines[i]) : ""}</p>`;
  return line(live - 1, "prev") + line(live, "live") + line(live + 1, "next");
}
