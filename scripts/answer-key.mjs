#!/usr/bin/env node
// The answer key for a dialogue's speaker turns, which tests/speakers.test.ts
// checks the engine against. It is written apart from the engine on purpose:
// it reads the text line by line (not by paragraph), takes the speakers'
// names from the edition's list of persons (given on the command line or by
// the test), and matches only "NAME:" at the start of a line after a blank
// line, so it shares no rule with web/src/engine/segment.ts. It is not a
// committed oracle: the test runs it on the text each time.
//
//   node scripts/answer-key.mjs crito SOCRATES CRITO
//
// Each turn is its speaker and the first six words after the label.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function answerKey(text, names) {
  const turns = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const turnStart = i === 0 || lines[i - 1].trim() === "";
    if (!turnStart) return;
    for (const name of names) {
      const label = `${name}:`;
      if (line.startsWith(label)) {
        const opens = line.slice(label.length).trim().split(/\s+/).slice(0, 6).join(" ");
        turns.push({ speaker: name, opens });
      }
    }
  });
  return turns;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [slug, ...names] = process.argv.slice(2);
  if (!slug || names.length === 0) {
    console.error("usage: node scripts/answer-key.mjs <work> <NAME> [<NAME> ...]");
    process.exit(1);
  }
  const text = readFileSync(path.join(repoRoot, "web", "public", "works", `${slug}.txt`), "utf8");
  process.stdout.write(JSON.stringify(answerKey(text, names), null, 1) + "\n");
}
