#!/usr/bin/env node
// Makes a work's performed passage (web/public/works/*.txt) from a Project
// Gutenberg plain-text file, the way the Cave was made, so every file there
// can be rebuilt by anyone from its source (CLAUDE.md, Law 2):
//   1. the upstream file must be the exact one pinned below (its SHA-256);
//   2. CRLF folded to LF;
//   3. only the performed lines, inclusive (the Gutenberg header, licence and
//      the translator's introduction are outside them);
//   4. with --drop-notes: the translator's apparatus is removed, and nothing
//      else: footnotes and the markers that point at them, and, only for
//      the eBooks in PLUS_MARKS, the "+" marks of a doubtful reading (George
//      Long's Meditations). Every word,
//      bracket and punctuation mark of the text itself stays, byte for byte.
//      The markers must match the notes one for one, so a genuine bracketed
//      capital ("[I]") can never vanish silently.
// The result's SHA-256 is pinned in tests/verbatim.test.ts with the same
// line range. This is the only sanctioned way to remove apparatus (founder,
// 2026-09-26). Not a gate step: the texts are committed, and the pins hold them.
//
//   node scripts/extract-work.mjs 15877 pg15877.txt 2496 2714 --drop-notes > web/public/works/meditations.txt

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SHA-256 of each upstream file as downloaded from
 * https://www.gutenberg.org/cache/epub/<n>/pg<n>.txt on 2026-09-26.
 * A newer upstream revision needs a new pin and a fresh look at the line range.
 */
export const UPSTREAM_SHA256 = {
  1497: "917c1cb469e1a8eba6083808764d7131da8d79140b575b4214c9d02a73ec4528",
  1657: "8f7e8c4cdb7ad512603f9359d5e7ce5c3aa281f7c83a07ac08c07bad90f9faae",
  15877: "6584df7e90d6035eece30d8028527290bf2508076963ee0376cb41db9cf88d5b",
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Throws unless the upstream bytes are the pinned file for this eBook. */
export function checkUpstream(ebook, bytes) {
  const pin = UPSTREAM_SHA256[ebook];
  if (!pin) throw new Error(`extract-work: no upstream pin for eBook ${ebook}`);
  const got = sha256(bytes);
  if (got !== pin) throw new Error(`extract-work: pg${ebook}.txt is sha256 ${got}, pinned ${pin}`);
}

/** Lines `from` to `to` (1-based, inclusive) of a Gutenberg file, LF only, ending in one newline. */
export function sliceLines(raw, from, to) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  return lines.slice(from - 1, to).join("\n") + "\n";
}

const MARKER = /\[[A-Z]\]/g;
const NOTE_LINE = /^ {4}\[[A-Z]\] /;

/**
 * eBooks whose translator marks a doubtful reading with "+" (Long says so in
 * his preface to #15877), and how many such marks the performed passage
 * holds. Only these lose their "+", and only when the count matches.
 */
export const PLUS_MARKS = { 15877: 3 };

/**
 * Removes the apparatus: indented footnote blocks ("    [A] Xenophon, ..."),
 * their markers ("teeth.[A]"), and, when `plusMarks` is a number, exactly that
 * many "+" marks, which always follow a word or a stop directly
 * ("sufficient.+ But"). Paragraphs are otherwise untouched. Throws when the
 * markers and the notes do not match one for one, or when the "+" count is
 * not the expected one.
 */
export function dropNotes(text, plusMarks = null) {
  const paras = text.replace(/\n+$/, "").split("\n\n");
  const isNoteBlock = (p) => p.split("\n").every((line) => /^ {4}\S/.test(line));
  const notes = paras.filter(isNoteBlock).flatMap((p) => p.split("\n").filter((line) => NOTE_LINE.test(line)));
  const kept = paras.filter((p) => !isNoteBlock(p)).join("\n\n");
  const markers = kept.match(MARKER) ?? [];
  if (markers.length !== notes.length) {
    throw new Error(`extract-work: ${markers.length} note markers in the text but ${notes.length} notes; refusing to remove them`);
  }
  let out = kept.replace(MARKER, "");
  if (plusMarks !== null) {
    const found = (out.match(/(?<=\S)\+/g) ?? []).length;
    if (found !== plusMarks) throw new Error(`extract-work: ${found} + marks in the text, expected ${plusMarks}; refusing to remove them`);
    out = out.replace(/(?<=\S)\+/g, "");
  }
  return out + "\n";
}

/** The whole extraction, from the upstream bytes. */
export function extractWork(bytes, ebook, from, to, withoutNotes = false) {
  checkUpstream(ebook, bytes);
  const text = sliceLines(bytes.toString("utf8"), from, to);
  return withoutNotes ? dropNotes(text, PLUS_MARKS[ebook] ?? null) : text;
}

function main() {
  const [ebook, file, from, to, flag] = process.argv.slice(2);
  if (!ebook || !file || !from || !to) {
    console.error("usage: node scripts/extract-work.mjs <eBook no.> <pg.txt> <first line> <last line> [--drop-notes]");
    process.exit(2);
  }
  process.stdout.write(extractWork(readFileSync(file), Number(ebook), Number(from), Number(to), flag === "--drop-notes"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
