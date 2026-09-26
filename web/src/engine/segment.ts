// Spark narration engine: cuts a source text into cues by its form only
// (Law 3). Nothing here reads for meaning, and nothing rewrites a word:
// every cue's `text` is a byte-exact slice of the source (Law 2), and
// `spoken` changes only whitespace, and drops a speaker label, so the voice
// reads what the page shows. Pure and deterministic; the same function runs
// in the tab and in Node.
//
// Speaker labels (Law 3 rule 1): a paragraph that opens with an ALL-CAPS
// name and a colon or full stop ("SOCRATES:  Why have you come") starts a
// turn by that speaker. The label stays in `text` (verbatim) and leaves
// `spoken`, and the turn's later sentences and paragraphs keep its speaker
// until the next label. The name is only ever a label here: nothing is
// inferred from it.

export type CueRule = "sentence" | "clause" | "paragraph-end" | "work-end";

/** How a cue got its speaker: its own label, or the turn it continues. */
export type SpeakerRule = "speaker-label" | "turn-continues";

export interface Cue {
  /** Index of the cue's first character in the source. */
  start: number;
  /** Index just past the cue's last character. */
  end: number;
  /** source.slice(start, end), verbatim. */
  text: string;
  /** What the voice is given: `text` with line breaks folded to spaces. */
  spoken: string;
  /** Silence after the cue, from the fixed pause table. */
  pauseAfterMs: number;
  /** The structural rule that ended the cue (shown in the Direction report later). */
  rule: CueRule;
  /** The speaker's label as printed ("SOCRATES"); absent where the text has no labels (the narrator). */
  speaker?: string;
  /** Why the cue has its speaker (shown in the Direction report later). */
  speakerRule?: SpeakerRule;
}

// The fixed pause table (brief: paragraph 0.6 s, chapter end 4.5 s).
export const PAUSE_MS: Record<CueRule, number> = {
  clause: 150,
  sentence: 300,
  "paragraph-end": 600,
  "work-end": 4500,
};

// Kokoro truncates at 512 tokens; a cue stays well under that.
export const MAX_CUE_CHARS = 320;

const EM_DASH = String.fromCharCode(0x2014);

/** Ends of sentences: . ? ! (and any closing quote or bracket) before whitespace. */
function sentenceEnds(para: string): number[] {
  const ends: number[] = [];
  const re = /[.?!]+["'’”)\]]*(?=\s)/g;
  for (let m = re.exec(para); m; m = re.exec(para)) ends.push(m.index + m[0].length);
  return ends;
}

/** Best place to break an over-long span: the clause mark nearest its middle, more than 20 characters past `from`. */
function clauseBreak(span: string, from: number): number | null {
  const marks: number[] = [];
  const re = new RegExp(`[;:,${EM_DASH}]`, "g");
  for (let m = re.exec(span); m; m = re.exec(span)) {
    const at = m.index + m[0].length;
    if (at > from + 20 && at < span.length - 20) marks.push(at);
  }
  if (marks.length === 0) return null;
  // Prefer the strongest mark: ; and : over the dash over the comma.
  for (const strength of [/[;:]$/, new RegExp(`${EM_DASH}$`), /,$/]) {
    const strong = marks.filter((at) => strength.test(span.slice(0, at)));
    if (strong.length) {
      const mid = span.length / 2;
      return strong.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
    }
  }
  return null;
}

/**
 * A speaker label at the start of a paragraph: an ALL-CAPS name of two or
 * more letters (words may be joined by one space), then ":" or ".", then
 * whitespace and a word. What is plainly not a speaker is refused, by its
 * form alone:
 * - a bare Roman numeral ("II.", "XIV."), a section number;
 * - a heading word ("BOOK II.", "CHAPTER THE FIRST.", "INTRODUCTION."),
 *   whatever follows it;
 * - an honorific or abbreviation with its full stop ("MR. Darcy",
 *   "ST. Paul", "NO. 7"), whatever follows it.
 */
const LABEL = /^([A-Z][A-Z'-]*[A-Z](?: [A-Z][A-Z'-]*[A-Z])*)([:.])\s+(?=\S)/;
const ROMAN = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;
const HEADINGS = new Set(["BOOK", "CHAPTER", "SCENE", "LETTER", "ACT", "PART", "INTRODUCTION", "ARGUMENT", "NOTE"]);
const HONORIFICS = new Set(["MR", "MRS", "MS", "DR", "ST", "NO"]);

/** The label that opens a paragraph: its name and its length (name, mark and the spaces after it). */
export function speakerLabel(para: string): { name: string; length: number } | null {
  const m = LABEL.exec(para);
  if (!m) return null;
  const name = m[1]!;
  if (ROMAN.test(name) || HEADINGS.has(name.split(" ")[0]!)) return null;
  if (m[2] === "." && HONORIFICS.has(name)) return null;
  return { name, length: m[0].length };
}

function trimmed(source: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(source[start]!)) start++;
  while (end > start && /\s/.test(source[end - 1]!)) end--;
  return [start, end];
}

/** The turn a cue belongs to: its speaker, and where the label that opened it ends in the source. */
interface Turn {
  speaker: string;
  labelEnd: number;
}

function pushSpan(out: Cue[], source: string, start: number, end: number, rule: CueRule, turn: Turn | null): void {
  [start, end] = trimmed(source, start, end);
  if (start >= end) return;
  const span = source.slice(start, end);
  if (span.length > MAX_CUE_CHARS) {
    // A label's own colon is never a break: the first part always has words after the label.
    const at = clauseBreak(span, turn && turn.labelEnd > start ? turn.labelEnd - start : 0);
    if (at !== null) {
      pushSpan(out, source, start, start + at, "clause", turn);
      pushSpan(out, source, start + at, end, rule, turn);
      return;
    }
  }
  const cue: Cue = { start, end, text: span, spoken: span.replace(/\s+/g, " "), pauseAfterMs: PAUSE_MS[rule], rule };
  if (turn) {
    const labelled = turn.labelEnd > start;
    if (labelled) cue.spoken = source.slice(turn.labelEnd, end).replace(/\s+/g, " ").trim();
    cue.speaker = turn.speaker;
    cue.speakerRule = labelled ? "speaker-label" : "turn-continues";
  }
  out.push(cue);
}

export function segment(source: string): Cue[] {
  const cues: Cue[] = [];
  const paraRe = /\n[ \t]*\n\s*/g;
  const paras: [number, number][] = [];
  let from = 0;
  for (let m = paraRe.exec(source); m; m = paraRe.exec(source)) {
    paras.push([from, m.index]);
    from = m.index + m[0].length;
  }
  paras.push([from, source.length]);

  let turn: Turn | null = null;
  for (const [pStart, pEnd] of paras) {
    const para = source.slice(pStart, pEnd);
    const label = speakerLabel(para);
    if (label) turn = { speaker: label.name, labelEnd: pStart + label.length };
    // A label's own mark ("SOCRATES.") never ends a sentence: the first cue runs from the label to the first real end.
    const skip = label?.length ?? 0;
    let s = 0;
    for (const e of sentenceEnds(para)) {
      if (e <= skip) continue;
      pushSpan(cues, source, pStart + s, pStart + e, "sentence", turn);
      s = e;
    }
    pushSpan(cues, source, pStart + s, pEnd, "sentence", turn);
    const last = cues.at(-1);
    if (last && last.end > pStart) {
      last.rule = "paragraph-end";
      last.pauseAfterMs = PAUSE_MS["paragraph-end"];
    }
  }
  const last = cues.at(-1);
  if (last) {
    last.rule = "work-end";
    last.pauseAfterMs = PAUSE_MS["work-end"];
  }
  return cues;
}

/** Law 2 check: the cues, with the whitespace between them, rebuild the source exactly. */
export function rebuild(source: string, cues: Cue[]): string {
  let out = "";
  let at = 0;
  for (const c of cues) {
    const gap = source.slice(at, c.start);
    if (/\S/.test(gap)) throw new Error(`segment: text dropped at ${at}: ${JSON.stringify(gap)}`);
    out += gap + c.text;
    at = c.end;
  }
  const tail = source.slice(at);
  if (/\S/.test(tail)) throw new Error(`segment: text dropped at ${at}`);
  return out + tail;
}
