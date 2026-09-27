// The voice table as casting reads it: design/voices.json projected, at
// build time, to the fields web/src/engine/cast.ts uses. The page never
// ships the measured table's provenance, pins or unused measurements.
// Served to the page and the tests as the virtual module
// "virtual:dial-voice-table" (vite.config.ts and vitest.config.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tablePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "design", "voices.json");

/** The fields casting reads, per voice. */
export const CAST_FIELDS = ["id", "sex", "accent", "grade", "wpm_as_played", "median_f0_hz", "spectral_centroid_hz"];

/** design/voices.json's voices, projected to CAST_FIELDS (grade lifted out of hexgrad). */
export function projectVoices(table) {
  return table.voices.map((v) => ({
    id: v.id,
    sex: v.sex,
    accent: v.accent,
    grade: v.hexgrad.grade,
    wpm_as_played: v.wpm_as_played,
    median_f0_hz: v.median_f0_hz,
    spectral_centroid_hz: v.spectral_centroid_hz,
  }));
}

const ID = "virtual:dial-voice-table";
const RESOLVED = "\0" + ID;

/** The Vite plugin that serves the projected table. */
export function voiceTable() {
  return {
    name: "dial-voice-table",
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      this.addWatchFile?.(tablePath);
      const voices = projectVoices(JSON.parse(readFileSync(tablePath, "utf8")));
      return `export const voices = ${JSON.stringify(voices)};\n`;
    },
  };
}
