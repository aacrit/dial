#!/usr/bin/env node
// Makes the hand-labelled answer key for a dialogue's speaker turns, which
// tests/speakers.test.ts checks the engine against. It is written apart from
// the engine on purpose: it reads the text line by line (not by paragraph)
// and knows the speakers' names from the edition's list of persons, so it
// shares no rule with web/src/engine/segment.ts.
//
//   node scripts/answer-key.mjs crito SOCRATES CRITO > tests/fixtures/crito-turns.json
//
// Each turn is its speaker and the first six words after the label. Checked
// when it was made (2026-09-26): Crito has 95 turns, 48 by SOCRATES and 47
// by CRITO, alternating from first to last.

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
