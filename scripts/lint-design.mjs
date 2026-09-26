#!/usr/bin/env node
// Enforces Ink & Momentum's token discipline: design/tokens.css is the only
// file allowed to define a color literal, and UI copy never uses an em dash.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./lib/walk.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS_FILE = path.join("design", "tokens.css").replace(/\\/g, "/");

const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}){1,2}\b/;
const FUNC_COLOR = /\b(?:rgb|rgba|hsl|hsla)\(/;
const EM_DASH = /—/;

const SCAN_DIRS = ["web", "worker", "design"];
const SCAN_EXTENSIONS = [".css", ".ts", ".tsx", ".html"];
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".wrangler"]);

// Author text is verbatim (Law 2: the words are the author's). Jowett prints
// "unenlightened:—Behold!", and the no-em-dash rule governs Dial's own UI
// copy, never an author's words. So a text file (.txt) under
// web/public/works/ is exempt from the em-dash check, and from nothing else:
// the colour check still reads every scanned file, works/ included, and any
// other file there (markup, script) is Dial's own and fully checked.
export const VERBATIM_DIRS = ["web/public/works/"];
export const VERBATIM_EXTENSIONS = [".txt"];

export function isVerbatimPath(relPath) {
  return VERBATIM_DIRS.some((dir) => relPath.startsWith(dir)) && VERBATIM_EXTENSIONS.includes(path.extname(relPath));
}

/** Whether the lint reads this repo-relative path at all (the colour check applies to all of them). */
export function shouldScan(relPath) {
  return SCAN_EXTENSIONS.includes(path.extname(relPath));
}

export function checkColorLine(relPath, line) {
  if (relPath === TOKENS_FILE) return null;
  if (HEX_COLOR.test(line) || FUNC_COLOR.test(line)) {
    return `${relPath}: color literal outside design/tokens.css - "${line.trim()}"`;
  }
  return null;
}

export function checkEmDashLine(relPath, line) {
  if (isVerbatimPath(relPath)) return null;
  const isUiCopyFile = relPath.endsWith(".html") || relPath.startsWith("web/src/");
  if (!isUiCopyFile) return null;
  if (EM_DASH.test(line)) {
    return `${relPath}: em dash in UI copy - "${line.trim()}"`;
  }
  return null;
}

function main() {
  const violations = [];

  for (const dir of SCAN_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs, SKIP_DIR_NAMES)) {
      const relPath = path.relative(repoRoot, file).replace(/\\/g, "/");
      if (!shouldScan(relPath)) continue;
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        const colorProblem = checkColorLine(relPath, line);
        if (colorProblem) violations.push(`${colorProblem} (line ${i + 1})`);
        const dashProblem = checkEmDashLine(relPath, line);
        if (dashProblem) violations.push(`${dashProblem} (line ${i + 1})`);
      });
    }
  }

  if (violations.length > 0) {
    console.error("lint-design: violations found\n" + violations.map((v) => `  - ${v}`).join("\n"));
    process.exit(1);
  }
  console.log("lint-design: no stray color literals or em dashes");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
