// Node module hooks that serve "virtual:dial-voice-table" to the tab's own
// TypeScript when a script runs it in Node (scripts/render-recordings.mjs),
// exactly as Vite serves it to the page (scripts/lib/voice-table.mjs).
// Also resolves the page's extensionless relative imports ("./cast-version")
// to their .ts files, as Vite does. Registered with node:module's register().

import { readFileSync } from "node:fs";
import { projectVoices } from "./voice-table.mjs";

const ID = "virtual:dial-voice-table";
const URL_ID = "dial-virtual:voice-table";

export async function resolve(specifier, context, next) {
  if (specifier === ID) return { url: URL_ID, shortCircuit: true };
  if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$|\.json$/.test(specifier) && context.parentURL?.endsWith(".ts")) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url !== URL_ID) return next(url, context);
  const table = JSON.parse(readFileSync(new URL("../../design/voices.json", import.meta.url), "utf8"));
  return { format: "module", shortCircuit: true, source: `export const voices = ${JSON.stringify(projectVoices(table))};\n` };
}
