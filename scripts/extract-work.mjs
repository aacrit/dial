#!/usr/bin/env node
// Makes a work's performed passage (web/public/works/*.txt) from a Project
// Gutenberg plain-text file, the way the Cave was made, so every file there
// can be rebuilt by anyone from its source:
//   1. CRLF folded to LF;
//   2. only the performed lines, inclusive (the Gutenberg header, licence and
//      the translator's introduction are outside them);
//   3. with --drop-notes (George Long's Meditations only): his footnotes and
//      the marks that point at them are removed, and so are his "+" marks of
//      a doubtful reading. Nothing else changes: every word, bracket and
//      punctuation mark between them stays, byte for byte.
// The result's SHA-256 is pinned in tests/verbatim.test.ts with the same
// line range. Not a gate step: the texts are committed, and the pins hold them.
//
//   node scripts/extract-work.mjs pg15877.txt 2496 2714 --drop-notes > web/public/works/meditations-2.txt

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Lines `from` to `to` (1-based, inclusive) of a Gutenberg file, LF only, ending in one newline. */
export function sliceLines(raw, from, to) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  return lines.slice(from - 1, to).join("\n") + "\n";
}

/**
 * Removes Long's apparatus: indented footnote blocks ("    [A] Xenophon, ..."),
 * their markers ("teeth.[A]"), and his "+" marks, which always follow a word
 * or a stop directly ("sufficient.+ But"). Paragraphs are otherwise untouched.
 */
export function dropNotes(text) {
  const paras = text.replace(/\n+$/, "").split("\n\n");
  const kept = paras.filter((p) => !p.split("\n").every((line) => /^ {4}\S/.test(line)));
  return (
    kept
      .join("\n\n")
      .replace(/\[[A-Z]\]/g, "")
      .replace(/(?<=\S)\+/g, "") + "\n"
  );
}

function main() {
  const [file, from, to, flag] = process.argv.slice(2);
  if (!file || !from || !to) {
    console.error("usage: node scripts/extract-work.mjs <pg.txt> <first line> <last line> [--drop-notes]");
    process.exit(2);
  }
  let text = sliceLines(readFileSync(file, "utf8"), Number(from), Number(to));
  if (flag === "--drop-notes") text = dropNotes(text);
  process.stdout.write(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
