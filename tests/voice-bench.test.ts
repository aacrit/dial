// T2c part 1: the voice bench's measurements (scripts/lib/voice-measure.mjs)
// on signals whose answer is known, and design/voices.json, the measured
// table casting reads, against its schema and the voice files kokoro-js ships.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeDbfs,
  countWords,
  medianF0,
  naturalWpm,
  pauseRatio,
  spectralCentroid,
  trimSilence,
  voicedSeconds,
} from "../scripts/lib/voice-measure.mjs";

const SR = 24000;
const root = path.resolve(__dirname, "..");

function sine(hz: number, seconds: number, amp = 0.5, sr = SR): Float32Array {
  return Float32Array.from({ length: Math.round(seconds * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));
}
function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const silence = (seconds: number) => new Float32Array(Math.round(seconds * SR));
/** A harmonic tone like a voiced vowel: fundamental plus decaying harmonics. */
function vowel(f0: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  for (let h = 1; h <= 8; h++) {
    const s = sine(f0 * h, seconds, 0.3 / h);
    for (let i = 0; i < out.length; i++) out[i]! += s[i]!;
  }
  return out;
}

describe("pitch (autocorrelation F0)", () => {
  for (const hz of [85, 110, 150, 220, 300]) {
    it(`a ${hz} Hz sine reads ${hz} Hz within 1 %`, () => {
      const f0 = medianF0(sine(hz, 1), SR);
      expect(f0).not.toBeNull();
      expect(Math.abs(f0! - hz) / hz).toBeLessThan(0.01);
    });
  }
  it("a harmonic tone reads its fundamental, not an octave off", () => {
    const f0 = medianF0(vowel(120, 1), SR);
    expect(Math.abs(f0! - 120)).toBeLessThan(2);
  });
  it("silence has no pitch, and leading silence does not move it", () => {
    expect(medianF0(silence(1), SR)).toBeNull();
    const f0 = medianF0(concat(silence(0.8), sine(140, 1), silence(0.8)), SR);
    expect(Math.abs(f0! - 140)).toBeLessThan(1.5);
  });
});

describe("silence trimming and wpm", () => {
  it("trims leading and trailing silence to the tone, within one 20 ms frame", () => {
    const x = concat(silence(0.5), sine(200, 2), silence(0.7));
    const { start, end } = trimSilence(x, SR);
    expect(Math.abs(start / SR - 0.5)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(end / SR - 2.5)).toBeLessThanOrEqual(0.02);
    expect(voicedSeconds(x, SR)).toBeCloseTo(2, 1);
  });
  it("keeps a pause inside the span as speaking time", () => {
    const x = concat(silence(0.3), sine(200, 1), silence(0.5), sine(200, 1), silence(0.3));
    expect(voicedSeconds(x, SR)).toBeCloseTo(2.5, 1);
  });
  it("wpm divides words by trimmed time, so padding a line does not slow it", () => {
    const bare = [{ words: 5, audio: sine(200, 2) }];
    const padded = [{ words: 5, audio: concat(silence(1), sine(200, 2), silence(1)) }];
    expect(naturalWpm(bare, SR)).toBeCloseTo(150, 0);
    expect(naturalWpm(padded, SR)).toBeCloseTo(150, 0);
  });
  it("sums words and trimmed time over cues", () => {
    const cues = [
      { words: 4, audio: concat(silence(0.4), sine(200, 1.5)) },
      { words: 6, audio: concat(sine(200, 2.5), silence(0.9)) },
    ];
    expect(naturalWpm(cues, SR)).toBeCloseTo(150, 0);
  });
  it("counts words across whitespace and dashes, not punctuation", () => {
    expect(countWords("trouble and unrest as you are--indeed I should not:  I")).toBe(11);
    expect(countWords("enlightened or unenlightened:—Behold! human")).toBe(5);
    expect(countWords("  —  ")).toBe(0);
  });
});

describe("pause ratio, loudness and spectral centroid", () => {
  it("counts only pauses of 150 ms or more inside the span", () => {
    const x = concat(silence(1), sine(200, 2), silence(1), sine(200, 2), silence(0.06), sine(200, 1), silence(1));
    // 1 s pause over 5.06 s of the rest (the 60 ms gap is too short to be a pause).
    expect(pauseRatio(x, SR)).toBeCloseTo(1 / 5.06, 1);
  });
  it("reads a full-scale sine at -3 dBFS and a half-scale one at -9 dBFS, ignoring silence", () => {
    expect(activeDbfs(sine(440, 1, 1), SR)).toBeCloseTo(-3.01, 1);
    expect(activeDbfs(concat(silence(2), sine(440, 1, 0.5)), SR)).toBeCloseTo(-9.03, 1);
  });
  it("puts a pure tone's centroid at the tone, and an even two-tone mix between them", () => {
    expect(Math.abs(spectralCentroid(sine(1000, 1), SR)! - 1000)).toBeLessThan(60);
    const mix = sine(500, 1, 0.4).map((v, i) => v + 0.4 * Math.sin((2 * Math.PI * 3000 * i) / SR));
    expect(Math.abs(spectralCentroid(mix, SR)! - 1750)).toBeLessThan(80);
  });
});

// ---- design/voices.json

type Voice = {
  id: string;
  sex: "m" | "f";
  accent: "us" | "uk";
  hexgrad: { grade: string; target_quality: string | null; training_duration: string | null };
  file_sha256: string;
  wpm: number;
  wpm_as_played: number;
  median_f0_hz: number;
  spectral_centroid_hz: number;
  loudness_dbfs: number;
  pause_to_speech: number;
  distance?: { speech_seconds: number; seconds_as_played: number; wpm_first_30s: number; wpm_last_30s: number; wpm_drift: number; f0_first_30s_hz: number; f0_last_30s_hz: number; f0_drift_hz: number };
};

const table = JSON.parse(readFileSync(path.join(root, "design", "voices.json"), "utf8")) as {
  provenance: Record<string, unknown> & { measured_source_data: string; passages: Record<string, { sha256: string; words_spoken: number }> };
  voices: Voice[];
};
const voiceDir = path.join(root, "node_modules", "kokoro-js", "voices");
const shippedEnglish = readdirSync(voiceDir)
  .filter((f) => /^[ab][fm]_[a-z]+\.bin$/.test(f))
  .map((f) => f.slice(0, -4))
  .sort();
const GRADES = /^(A|A-|B\+|B|B-|C\+|C|C-|D\+|D|D-|F\+|F)$/;

describe("design/voices.json", () => {
  it("says it is measured source data, with its provenance", () => {
    const p = table.provenance;
    expect(p.measured_source_data).toMatch(/measured source data/i);
    for (const key of ["date", "engine", "method", "passages", "hexgrad_table"]) expect(p).toHaveProperty(key);
    for (const passage of Object.values(p.passages)) {
      expect(passage.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(passage.words_spoken).toBeGreaterThan(0);
    }
  });

  it("covers every English voice file kokoro-js ships, once each, with its file's sha256", () => {
    expect(shippedEnglish.length).toBeGreaterThan(20);
    expect(table.voices.map((v) => v.id).sort()).toEqual(shippedEnglish);
    for (const v of table.voices) {
      const sha = createHash("sha256").update(readFileSync(path.join(voiceDir, `${v.id}.bin`))).digest("hex");
      expect(v.file_sha256, v.id).toBe(sha);
    }
  });

  it("each entry fits the schema, and its sex and accent agree with its id", () => {
    for (const v of table.voices) {
      expect(v.sex, v.id).toBe(v.id[1] === "m" ? "m" : "f");
      expect(v.accent, v.id).toBe(v.id[0] === "a" ? "us" : "uk");
      expect(v.hexgrad.grade, v.id).toMatch(GRADES);
      expect(v.wpm, v.id).toBeGreaterThan(80);
      expect(v.wpm, v.id).toBeLessThan(300);
      // As played, the tab's pauses and Kokoro's own silences slow every voice below its articulation rate.
      expect(v.wpm_as_played, v.id).toBeGreaterThan(60);
      expect(v.wpm_as_played, v.id).toBeLessThan(v.wpm);
      expect(v.median_f0_hz, v.id).toBeGreaterThan(60);
      expect(v.median_f0_hz, v.id).toBeLessThan(400);
      expect(v.spectral_centroid_hz, v.id).toBeGreaterThan(300);
      expect(v.spectral_centroid_hz, v.id).toBeLessThan(6000);
      expect(v.loudness_dbfs, v.id).toBeLessThan(0);
      expect(v.pause_to_speech, v.id).toBeGreaterThanOrEqual(0);
    }
  });

  it("measures holding over distance for af_heart and the four male narrator candidates only", () => {
    const withDistance = table.voices.filter((v) => v.distance).map((v) => v.id).sort();
    expect(withDistance).toEqual(["af_heart", "am_fenrir", "am_michael", "am_puck", "bm_george"]);
    for (const v of table.voices.filter((x) => x.distance)) // About 3 minutes as the tab plays it.
      expect(v.distance!.seconds_as_played, v.id).toBeGreaterThan(160);
  });
});
