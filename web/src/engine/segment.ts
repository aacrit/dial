// Spark narration engine: cuts a source text into cues by its form only
// (Law 3). Nothing here reads for meaning, and nothing rewrites a word:
// every cue's `text` is a byte-exact slice of the source (Law 2), and
// `spoken` changes only whitespace, so the voice reads what the page shows.
// Pure and deterministic; the same function runs in the tab and in Node.

export type CueRule = "sentence" | "clause" | "paragraph-end" | "work-end";

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

/** Best place to break an over-long span: the clause mark nearest its middle. */
function clauseBreak(span: string): number | null {
  const marks: number[] = [];
  const re = new RegExp(`[;:,${EM_DASH}]`, "g");
  for (let m = re.exec(span); m; m = re.exec(span)) {
    const at = m.index + m[0].length;
    if (at > 20 && at < span.length - 20) marks.push(at);
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

function trimmed(source: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(source[start]!)) start++;
  while (end > start && /\s/.test(source[end - 1]!)) end--;
  return [start, end];
}

function pushSpan(out: Cue[], source: string, start: number, end: number, rule: CueRule): void {
  [start, end] = trimmed(source, start, end);
  if (start >= end) return;
  const span = source.slice(start, end);
  if (span.length > MAX_CUE_CHARS) {
    const at = clauseBreak(span);
    if (at !== null) {
      pushSpan(out, source, start, start + at, "clause");
      pushSpan(out, source, start + at, end, rule);
      return;
    }
  }
  out.push({ start, end, text: span, spoken: span.replace(/\s+/g, " "), pauseAfterMs: PAUSE_MS[rule], rule });
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

  for (const [pStart, pEnd] of paras) {
    const para = source.slice(pStart, pEnd);
    let s = 0;
    for (const e of sentenceEnds(para)) {
      pushSpan(cues, source, pStart + s, pStart + e, "sentence");
      s = e;
    }
    pushSpan(cues, source, pStart + s, pEnd, "sentence");
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
