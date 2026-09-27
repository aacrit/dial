// T5: Dial's prepared recordings. The lock and its pins, the timing index's
// maths, the player's source of lines, chapter_rendered once per listen on
// both paths, what Save for offline keeps and Remove deletes, and the
// contract, each held here without a browser.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { WORKS } from "../web/src/catalogue";
import { countsAsRendered } from "../web/src/broadcast-state";
import { CAST_ENGINE_VERSION, tryCast } from "../web/src/engine/cast";
import { segment } from "../web/src/engine/segment";
import {
  RECORDING_FORMAT,
  RECORDING_RATE,
  cueHash,
  cuesDigest,
  expectedDigest,
  indexProblem,
  lineAtTime,
  lineSeconds,
  lineSlice,
  partBreaks,
  partOfLine,
  recordingBytes,
  seekTo,
  type RecordingIndex,
} from "../web/src/recording/timing";
import { MAX_DECODED_PARTS, Recording, recordingPins } from "../web/src/recording/source";
import {
  NO_VOICES,
  isSaved,
  parseVoices,
  planTotal,
  recordingFiles,
  recordingKeysOf,
  recordingOnDevice,
  recordingSavedLine,
  sizeLine,
  voicesToRemove,
  type RecordingPlan,
} from "../web/src/offline/plan";
import { offlineKey, route } from "../web/src/offline/routes";
import { preparedDoneLine, preparedSkippedLine, preparedOnAirLine, progressLine, recordingStopLine, PLAYS_AT_ONCE, MAKE_IT_HERE } from "../web/src/status-copy";
import { bookplateHtml, madeOn, recordingSentence } from "../web/src/render";
import { assetUrl, indexMatchesLock, lockFrom, lockProblems, privateIndexEntries, releaseTag } from "../scripts/lib/recordings-lock.mjs";
import { stage } from "../scripts/fetch-recordings.mjs";
import { whatItWas } from "../web/src/request-log";
import { Scheduler } from "../web/src/player/scheduler";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const SLUGS = WORKS.map((w) => w.slug);

/** A small index over `n` lines of the given speech and pause samples, in parts of `per` lines. */
function fakeIndex(lines: { speech: number; pause: number; hash?: string }[], per: number): RecordingIndex {
  let at = 0;
  const out = lines.map((l, i) => {
    const row = { at, speech: l.speech, pause: l.pause, hash: l.hash ?? `h${i}` };
    at += l.speech + l.pause;
    return row;
  });
  const parts = [];
  for (let from = 0, p = 0; from < lines.length; from += per, p++) {
    const to = Math.min(lines.length, from + per);
    const end = to < lines.length ? out[to]!.at : at;
    parts.push({ file: `part${p}.webm`, start: out[from]!.at / RECORDING_RATE, seconds: (end - out[from]!.at) / RECORDING_RATE, from, to, bytes: 10, sha256: "0".repeat(64) });
  }
  return {
    format: RECORDING_FORMAT,
    slug: "cave",
    made: "2026-09-27",
    engine: { cast: CAST_ENGINE_VERSION, model: "m", modelSha256: "x", dtype: "q8", kokoroJs: "1", runtime: "r", device: "cpu (16 threads)" },
    sampleRate: RECORDING_RATE,
    samples: at,
    digest: "d",
    codec: "opus/webm",
    bitrate: 48000,
    parts,
    lines: out,
  };
}

describe("the timing index", () => {
  it("a line's hash covers its place in the text, its voice, its words and its silence", async () => {
    const cue = { start: 10, end: 40, spoken: "And now, I said.", pauseAfterMs: 300 };
    const h = await cueHash(cue, "am_michael");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await cueHash({ ...cue }, "am_michael")).toBe(h);
    expect(await cueHash(cue, "af_heart")).not.toBe(h);
    expect(await cueHash({ ...cue, spoken: "And now, I said!" }, "am_michael")).not.toBe(h);
    expect(await cueHash({ ...cue, pauseAfterMs: 600 }, "am_michael")).not.toBe(h);
    expect(await cueHash({ ...cue, start: 11 }, "am_michael")).not.toBe(h);
    expect(await cuesDigest([h, h])).not.toBe(await cuesDigest([h]));
  });

  it("a line at time t, and a seek, land on the line whose span holds t", () => {
    const idx = fakeIndex([{ speech: 24000, pause: 7200 }, { speech: 48000, pause: 14400 }, { speech: 12000, pause: 108000 }], 2);
    // Line 0: 0 to 1.3 s; line 1: 1.3 to 3.9 s; line 2: 3.9 to 9.0 s.
    expect(lineAtTime(idx, 0)).toBe(0);
    expect(lineAtTime(idx, 1.29)).toBe(0);
    expect(lineAtTime(idx, 1.3)).toBe(1);
    expect(lineAtTime(idx, 3.9)).toBe(2);
    expect(lineAtTime(idx, 1e6)).toBe(2);
    expect(seekTo(idx, 2)).toEqual({ index: 1, offset: expect.closeTo(0.7, 9) });
    expect(seekTo(idx, -5)).toEqual({ index: 0, offset: 0 });
    // At or past the end, there is nothing to play.
    expect(seekTo(idx, 9)).toBeNull();
    expect(lineSeconds(idx)[1]).toEqual({ speech: 2, pause: 0.6 });
  });

  it("each line's speech is sliced from its own part, at the decoded rate", () => {
    const idx = fakeIndex([{ speech: 24000, pause: 7200 }, { speech: 48000, pause: 14400 }, { speech: 12000, pause: 108000 }], 2);
    expect(partOfLine(idx, 0)).toBe(0);
    expect(partOfLine(idx, 1)).toBe(0);
    expect(partOfLine(idx, 2)).toBe(1);
    expect(partOfLine(idx, 3)).toBe(-1);
    // Line 1 starts 1.3 s into part 0: at 48 kHz, frame 62400, for 96000 frames.
    expect(lineSlice(idx, 1, 48000, 1_000_000)).toEqual({ from: 62400, frames: 96000 });
    // Line 2 is the first in part 1.
    expect(lineSlice(idx, 2, 24000, 200_000)).toEqual({ from: 0, frames: 12000 });
    // A decoder that trims a frame never reads past what it decoded.
    expect(lineSlice(idx, 1, 24000, 70000)).toEqual({ from: 31200, frames: 70000 - 31200 });
  });

  it("parts start only at a line start, about every N seconds", () => {
    const lines = Array.from({ length: 10 }, () => ({ speech: 24000 * 20, pause: 24000 }));
    // 21 s per line; parts of at least 60 s: lines 0-2 (63 s), then 3-5, 6-8, 9.
    expect(partBreaks(lines, 24000, 60)).toEqual([0, 3, 6, 9]);
    expect(partBreaks([], 24000, 60)).toEqual([0]);
  });

  it("an index stands in for a render made here only when it is sound and its lines are the text's", () => {
    const idx = fakeIndex([{ speech: 100, pause: 10 }, { speech: 200, pause: 20 }], 1);
    const want = { digest: "d", lines: 2, castVersion: CAST_ENGINE_VERSION };
    expect(indexProblem(idx, want)).toBeNull();
    expect(indexProblem({ ...idx, digest: "other" }, want)).toMatch(/differ/);
    expect(indexProblem(idx, { ...want, lines: 3 })).toMatch(/2 lines, the text has 3/);
    expect(indexProblem(idx, { ...want, castVersion: "999" })).toMatch(/cast engine/);
    expect(indexProblem({ ...idx, format: 2 }, want)).toMatch(/format/);
    expect(indexProblem({ ...idx, samples: idx.samples + 1 }, want)).toMatch(/add up/);
    expect(indexProblem({ ...idx, lines: [idx.lines[0]!, { ...idx.lines[1]!, at: 5 }] }, want)).toMatch(/follow/);
    expect(indexProblem({ ...idx, parts: [idx.parts[0]!] }, want)).toMatch(/cover/);
    expect(indexProblem({ ...idx, parts: [idx.parts[1]!, idx.parts[0]!] }, want)).toMatch(/tile/);
    expect(recordingBytes(idx, 5)).toBe(25);
  });

  it("the page's expected digest is computed from the same cues and cast the render used", async () => {
    const w = WORKS.find((x) => x.slug === "crito")!;
    const cues = segment(read("web/public/works/crito.txt"));
    const c = tryCast(cues, w.cast)!;
    const d = await expectedDigest(cues, c.voices);
    expect(await expectedDigest(cues, c.voices)).toBe(d);
    const swapped = [...c.voices];
    const i = swapped.findIndex((v) => v !== swapped[0]);
    swapped[i] = swapped[0]!;
    expect(await expectedDigest(cues, swapped)).not.toBe(d);
    await expect(expectedDigest(cues, c.voices.slice(1))).rejects.toThrow(/one voice per line/);
  });
});

describe("the prepared recording as a source of lines", () => {
  const idx = fakeIndex(
    Array.from({ length: 8 }, () => ({ speech: 2400, pause: 240 })),
    2,
  );
  const partBytes = (p: number) => Buffer.from(`part ${p}`);
  for (const p of idx.parts) {
    const b = partBytes(Number(p.file.match(/\d+/)![0]));
    p.bytes = b.length;
    p.sha256 = sha256(b);
  }
  const make = (fetched: string[], decodeFail = false) =>
    new Recording(
      "cave",
      idx,
      { bytes: 1, sha256: "i" },
      async (bytes) => {
        if (decodeFail) throw new DOMException("Unable to decode audio data", "EncodingError");
        // A part of two lines decodes to its samples, each frame holding its part's number.
        const p = Number(new TextDecoder().decode(bytes).split(" ")[1]);
        return new Float32Array(2 * (2400 + 240)).fill((p + 1) / 10);
      },
      async (file) => {
        fetched.push(file);
        const b = partBytes(Number(file.match(/\d+/)![0]));
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    );

  it("gives each line's speech as 16-bit samples at 24 kHz, from its own part, and fetches the next part ahead", async () => {
    const fetched: string[] = [];
    const rec = make(fetched);
    expect(rec.lineCount).toBe(8);
    expect(rec.line(3)).toEqual({ speech: 0.1, pause: 0.01 });
    const s = await rec.samples(2);
    expect(s).toBeInstanceOf(Int16Array);
    expect(s.length).toBe(2400);
    expect(s[0]).toBe(Math.trunc(0.2 * 0x7fff));
    // Line 2 opens part 1, so part 2 is fetched ahead.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetched).toEqual(["part1.webm", "part2.webm"]);
    // A part is fetched once, however many of its lines are asked for.
    await rec.samples(3);
    expect(fetched.filter((f) => f === "part1.webm")).toHaveLength(1);
  });

  it("holds only a few decoded parts, so a long work never sits whole in memory", async () => {
    const rec = make([]);
    for (let i = 0; i < 8; i++) await rec.samples(i);
    expect(rec.held).toBeLessThanOrEqual(MAX_DECODED_PARTS);
  });

  it("refuses a part that does not match its pin, and asks again afresh after a failure", async () => {
    const fetched: string[] = [];
    const bad = new Recording("cave", idx, { bytes: 1, sha256: "i" }, async () => new Float32Array(10), async (file) => {
      fetched.push(file);
      return new TextEncoder().encode("tampered").buffer;
    });
    await expect(bad.samples(0)).rejects.toThrow(/did not match its pin/);
    await expect(bad.samples(0)).rejects.toThrow(/did not match its pin/);
    expect(fetched.filter((f) => f === "part0.webm")).toHaveLength(2);
    await expect(make([], true).samples(0)).rejects.toThrow(/decode/);
  });

  it("the copy for a recording that stops names what happened and the fix", () => {
    expect(recordingStopLine("recording part part3.webm: 503")).toMatch(/could not send its recording/);
    expect(recordingStopLine("TypeError: Failed to fetch")).toMatch(/Check your connection/);
    expect(recordingStopLine("Error: recording: a part did not match its pin")).toMatch(/arrived damaged/);
    expect(recordingStopLine("EncodingError: Unable to decode audio data")).toMatch(/make it on this device instead/i);
    expect(recordingStopLine("weird")).toMatch(/stopped unexpectedly/);
  });
});

describe("a prepared recording plays through the one scheduler, and seeks across the whole work", () => {
  it("every line goes to the scheduler at once, fully made, so a seek anywhere lands and the end fires once", async () => {
    const idx = fakeIndex(Array.from({ length: 6 }, () => ({ speech: 24000 * 10, pause: 24000 })), 2);
    const rec = new Recording("cave", idx, { bytes: 1, sha256: "i" }, async () => new Float32Array(0), async () => new ArrayBuffer(0));
    let now = 0;
    let completed = 0;
    const asked: number[] = [];
    const sched = new Scheduler<number>(rec.lineCount, {
      now: () => now,
      samples: (i) => {
        asked.push(i);
        return new Int16Array(24000 * 10);
      },
      start: (i) => i,
      stop: () => undefined,
      complete: () => completed++,
    });
    for (let i = 0; i < rec.lineCount; i++) sched.add(i, rec.line(i).speech, rec.line(i).pause);
    sched.renderFinished();
    expect(sched.madeSeconds).toBeCloseTo(66, 6);
    // Line 5 starts at 55 s: a seek to 60 s lands 5 s into it, although playback has barely begun.
    const to = sched.seek(60)!;
    expect(to).toMatchObject({ index: 5, beyond: false, finished: false });
    expect(to.offset).toBeCloseTo(5, 6);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toContain(5);
    // Past the end, the listen is over, once.
    expect(sched.seek(1e6)!.finished).toBe(true);
    expect(completed).toBe(1);
  });

  it("the page gives the scheduler every line of the recording, fully made, and its samples from the recording", () => {
    const main = read("web/src/main.ts");
    expect(main).toMatch(/if \(rec\) \{[\s\S]*?for \(let i = 0; i < rec\.lineCount; i\+\+\) \{\s*const l = rec\.line\(i\);\s*sched\.add\(i, l\.speech, l\.pause\);[\s\S]*?own\.renderDone = true;[\s\S]*?sched\.renderFinished\(\);\s*return;/);
    expect(main).toMatch(/if \(rec\) \{\s*return rec\.samples\(i\)\.catch\(/);
    expect(main).toContain("let sampleRate = rec ? RECORDING_RATE : 24_000;");
    // One analyser for both paths: the wave, meters and eye read the recording like a render.
    expect(main.match(/audio\.createAnalyser\(\)/g)).toHaveLength(1);
  });
});

describe("chapter_rendered: once per listen, on either path (founder, G2 round 1)", () => {
  it("a work made here counts when its last line is made; a prepared recording when its listen reaches the end", () => {
    expect(countsAsRendered("made", "all-made", false)).toBe(true);
    expect(countsAsRendered("made", "ended", false)).toBe(false);
    expect(countsAsRendered("prepared", "ended", false)).toBe(true);
    expect(countsAsRendered("prepared", "all-made", false)).toBe(false);
    // Never twice for one listen.
    for (const k of ["made", "prepared"] as const) for (const m of ["all-made", "ended"] as const) expect(countsAsRendered(k, m, true)).toBe(false);
  });

  it("the page sends it only through count(), once per session, at done for a render and at ended for a recording", () => {
    const main = read("web/src/main.ts");
    // reportCoreSuccess is defined once and called only inside count().
    expect(main.match(/reportCoreSuccess\(\)/g)).toHaveLength(2);
    expect(main).toMatch(/const count = \(moment: "all-made" \| "ended"\) => \{\s*if \(!countsAsRendered\(own\.kind, moment, own\.counted\)\) return;\s*own\.counted = true;\s*reportCoreSuccess\(\);/);
    expect(main).toMatch(/msg\.type === "done"\) \{[\s\S]*?count\("all-made"\);/);
    expect(main).toMatch(/const ended = \(\) => \{[\s\S]*?if \(!own\.seeking\) count\("ended"\);/);
    // A session starts uncounted, and knows which path it is on.
    expect(main).toMatch(/kind: rec \? "prepared" : "made",\s*counted: false,\s*seeking: false,/);
    // A skip past the end ends the broadcast but is not a listen reaching its end: seekAndSay marks the seek around the scheduler's call.
    expect(main).toMatch(/s\.seeking = true;\s*let target[^\n]*\n\s*try \{\s*target = s\.sched\.seek\(t\);\s*\} finally \{\s*s\.seeking = false;/);
  });
});

describe("Save for offline with a prepared recording", () => {
  const parts = [
    { file: "part0.webm", bytes: 400_000 },
    { file: "part1.webm", bytes: 350_000 },
  ];
  const files = recordingFiles("cave", parts, 30_000, { recordingsBytes: 900, voiceManifestBytes: 2_000 });

  it("keeps the parts, the index, the recordings list and the voice manifest, with their true sizes, and no voice", () => {
    expect(files.map((f) => f.path)).toEqual(["/recordings/cave/part0.webm", "/recordings/cave/part1.webm", "/recordings/cave/index.json", "/recordings/manifest.json", "/voice/manifest.json"]);
    expect(files.some((f) => /\/voice\/(voices|models)\/|\/ort\//.test(f.path))).toBe(false);
    const plan: RecordingPlan = { kind: "recording", textBytes: 29_000, textSaved: false, files: files.map((f) => ({ ...f, kept: false })) };
    expect(planTotal(plan)).toBe(29_000 + 400_000 + 350_000 + 30_000 + 900 + 2_000);
    expect(sizeLine(plan)).toBe("0.8 MB: the recording Dial made in advance, and its text. No voice download.");
    expect(isSaved(plan, true)).toBe(false);
    const done = { ...plan, textSaved: true, files: plan.files.map((f) => ({ ...f, kept: true })) };
    expect(isSaved(done, true)).toBe(true);
    expect(isSaved(done, false)).toBe(false);
    expect(planTotal(done)).toBe(0);
    expect(recordingOnDevice(done)).toBe(planTotal(plan));
    expect(recordingSavedLine(recordingOnDevice(done), true)).toBe("Plays in Dial with no connection. 0.8 MB on this device: the recording Dial made in advance, with no voice download.");
    expect(recordingSavedLine(1, false)).toContain("may clear it if the device runs short of space");
    // Only the small lists missing: said as such, in kilobytes.
    const lists = { ...done, files: done.files.map((f) => (f.path.startsWith("/recordings/cave/") ? f : { ...f, kept: false })) };
    expect(sizeLine(lists)).toBe("3 kB: the rest of what the recording needs offline. No voice download.");
  });

  it("Remove deletes the work's own parts and index, never another work's or the shared lists", () => {
    const keys = ["/works/cave.txt", "/recordings/cave/part0.webm", "/recordings/cave/index.json", "/recordings/crito/part0.webm", "/recordings/manifest.json", "/voice/manifest.json", "/recordings/cave/../crito/index.json"];
    expect(recordingKeysOf(keys, "cave")).toEqual(["/recordings/cave/part0.webm", "/recordings/cave/index.json"]);
    const store = read("web/src/offline/store.ts");
    expect(store).toMatch(/await cache\.delete\(workKey\(slug\)\);\s*\/\/[^\n]*\n\s*for \(const key of recordingKeysOf\(/);
  });

  it("a work saved with its recording records no voices, so it keeps none and asks for none", () => {
    expect(parseVoices(NO_VOICES)).toEqual([]);
    expect(read("web/src/offline/store.ts")).toContain("[VOICES_HEADER]: NO_VOICES");
    // Removing a voice-saved work: the recording-saved one needs no voice, so the voice goes.
    const saved = new Map<string, readonly string[] | null>([
      ["crito", ["am_fenrir"]],
      ["cave", []],
    ]);
    expect(voicesToRemove("crito", saved, new Map([["cave", []]]))).toEqual(["am_fenrir"]);
    expect(voicesToRemove("cave", saved, new Map([["crito", ["am_fenrir"]]]))).toEqual([]);
    expect(read("web/src/offline/ui.ts")).toContain("if (t) today.set(slug, t.recording ? [] : workVoices(t.voices));");
  });

  it("the offline helper serves a saved recording's files, and only those paths, from the saved cache", () => {
    const origin = "https://dial.voidvision.org";
    const at = (p: string) => route(new URL(p, origin), "GET", origin);
    expect(at("/recordings/manifest.json")).toBe("saved");
    expect(at("/recordings/cave/index.json")).toBe("saved");
    expect(at("/recordings/cave/part12.webm")).toBe("saved");
    expect(at("/recordings/cave/other.bin")).toBe("ignore");
    expect(at("/recordings/")).toBe("ignore");
    expect(route(new URL("/recordings/cave/part0.webm", "https://elsewhere.example"), "GET", origin)).toBe("ignore");
  });

  it("the offline key includes the recordings' pins; with none it is the key it was before", () => {
    const pins = { sha256: "a".repeat(64), runtimeSha256: "b".repeat(64), voices: { am_michael: "m" } };
    const before = offlineKey(pins, "2");
    expect(offlineKey(pins, "2", {})).toBe(before);
    const k = offlineKey(pins, "2", { cave: "c1", crito: "k1" });
    expect(k).not.toBe(before);
    expect(offlineKey(pins, "2", { crito: "k1", cave: "c1" })).toBe(k);
    expect(offlineKey(pins, "2", { cave: "c2", crito: "k1" })).not.toBe(k);
    expect(recordingPins({ format: 1, tag: "t", works: { cave: { index: "c1", bytes: 1, parts: 1, seconds: 1, made: "", cast: "2", model: "", device: "" } } })).toEqual({ cave: "c1" });
    expect(recordingPins(null)).toEqual({});
  });
});

describe("recordings.lock.json and its pins", () => {
  /** A render folder with fake masters for the given slugs. */
  function fakeRender(slugs: string[]) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dial-rec-"));
    for (const slug of slugs) {
      mkdirSync(path.join(dir, slug));
      const part = Buffer.from(`${slug} audio`);
      writeFileSync(path.join(dir, slug, "part0.webm"), part);
      const index = { ...fakeIndex([{ speech: 10, pause: 1 }], 1), slug };
      index.parts[0] = { ...index.parts[0]!, bytes: part.length, sha256: sha256(part) };
      const indexText = JSON.stringify(index);
      writeFileSync(path.join(dir, slug, "index.json"), indexText);
      writeFileSync(
        path.join(dir, slug, "manifest.json"),
        JSON.stringify({
          slug,
          made: "2026-09-27",
          provider: "cpu",
          engine: { cast: CAST_ENGINE_VERSION, model: "onnx-community/Kokoro-82M-v1.0-ONNX@1939ad2" },
          cast: { voices: ["am_michael"] },
          index: { file: "index.json", bytes: Buffer.byteLength(indexText), sha256: sha256(indexText) },
          parts: [{ file: "part0.webm", bytes: part.length, sha256: sha256(part), seconds: 1 }],
        }),
      );
    }
    return dir;
  }

  it("a lock written from a render pins every file at its release asset, and a work without one says so", () => {
    const dir = fakeRender(["cave", "crito"]);
    const lock = lockFrom(dir, SLUGS, { castVersion: CAST_ENGINE_VERSION, date: "2026-09-27" });
    expect(lock.tag).toBe(releaseTag(CAST_ENGINE_VERSION, "2026-09-27"));
    expect(lock.works.meditations).toEqual({ recording: false });
    expect(lock.works.cave.parts[0].url).toBe(assetUrl("aacrit/dial", lock.tag, "cave", "part0.webm"));
    expect(lock.works.cave.parts[0].url).toBe(`https://github.com/aacrit/dial/releases/download/${lock.tag}/cave.part0.webm`);
    expect(lockProblems(lock, SLUGS, CAST_ENGINE_VERSION)).toEqual([]);
    // Hashes and URLs only: no audio or base64 anywhere in it.
    expect(JSON.stringify(lock).length).toBeLessThan(5_000);
  });

  it("refuses an unsound lock: a bad pin, a moved URL, a missing work, another cast engine, an unknown work", () => {
    const lock = lockFrom(fakeRender(["cave"]), SLUGS, { castVersion: CAST_ENGINE_VERSION, date: "2026-09-27" });
    const clone = () => JSON.parse(JSON.stringify(lock));
    let l = clone();
    l.works.cave.parts[0].sha256 = "XYZ";
    expect(lockProblems(l, SLUGS, CAST_ENGINE_VERSION).join()).toMatch(/64 lowercase hex/);
    l = clone();
    l.works.cave.parts[0].url = "https://example.com/cave.part0.webm";
    expect(lockProblems(l, SLUGS, CAST_ENGINE_VERSION).join()).toMatch(/release asset/);
    l = clone();
    delete l.works.crito;
    expect(lockProblems(l, SLUGS, CAST_ENGINE_VERSION).join()).toMatch(/crito: not in the lock/);
    expect(lockProblems(lock, SLUGS, "999").join()).toMatch(/make them again/);
    l = clone();
    l.works.phaedo = { recording: false };
    expect(lockProblems(l, SLUGS, CAST_ENGINE_VERSION).join()).toMatch(/phaedo: not a work/);
    l = clone();
    l.works.cave.parts[0].bytes = 21 * 1024 * 1024;
    expect(lockProblems(l, SLUGS, CAST_ENGINE_VERSION).join()).toMatch(/over 20 MiB/);
  });

  it("staging copies each pinned file after checking it, and writes the list the page reads", async () => {
    const dir = fakeRender(["cave"]);
    const lockFile = path.join(dir, "lock.json");
    writeFileSync(lockFile, JSON.stringify(lockFrom(dir, SLUGS, { castVersion: CAST_ENGINE_VERSION, date: "2026-09-27" })));
    const out = path.join(dir, "staged");
    const neverFetch = async () => {
      throw new Error("no network in this test");
    };
    const m = await stage({ from: dir, lockFile, out, cache: path.join(dir, "cache"), fetchImpl: neverFetch as never, slugs: SLUGS, castVersion: CAST_ENGINE_VERSION });
    expect(Object.keys(m.works)).toEqual(["cave"]);
    expect(readFileSync(path.join(out, "cave", "part0.webm"), "utf8")).toBe("cave audio");
    expect(existsSync(path.join(out, "cave", "index.json"))).toBe(true);
    const list = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    expect(list.works.cave.index).toBe(sha256(readFileSync(path.join(dir, "cave", "index.json"))));
    expect(list.works.cave.bytes).toBe(readFileSync(path.join(dir, "cave", "index.json")).length + "cave audio".length);
  });

  it("staging fails loudly when a pinned file is missing or differs, and leaves the last good staging in place", async () => {
    const dir = fakeRender(["cave"]);
    const lockFile = path.join(dir, "lock.json");
    const lock = lockFrom(dir, SLUGS, { castVersion: CAST_ENGINE_VERSION, date: "2026-09-28" });
    writeFileSync(lockFile, JSON.stringify(lock));
    const out = path.join(dir, "staged");
    mkdirSync(out);
    writeFileSync(path.join(out, "keep.txt"), "last good");
    const offline = async () => {
      throw new Error("getaddrinfo ENOTFOUND github.com");
    };
    // Not in the cache, no local render: the download fails, and so does the build.
    await expect(stage({ lockFile, out, cache: path.join(dir, "cache"), fetchImpl: offline as never, slugs: SLUGS, castVersion: CAST_ENGINE_VERSION })).rejects.toThrow(/could not be fetched/);
    const answers404 = async () => new Response("", { status: 404 });
    await expect(stage({ lockFile, out, cache: path.join(dir, "cache"), fetchImpl: answers404 as never, slugs: SLUGS, castVersion: CAST_ENGINE_VERSION })).rejects.toThrow(/answered 404/);
    // A local render that differs from the pin.
    writeFileSync(path.join(dir, "cave", "part0.webm"), "cave audiX");
    const tampered = { ...lock, tag: "recordings-2-2026-09-29" };
    for (const w of Object.values(tampered.works) as { parts?: { url: string; file: string }[]; index?: { url: string; file: string } }[]) {
      for (const f of [...(w.parts ?? []), ...(w.index ? [w.index] : [])]) f.url = assetUrl("aacrit/dial", tampered.tag, "cave", f.file);
    }
    writeFileSync(lockFile, JSON.stringify(tampered));
    await expect(stage({ from: dir, lockFile, out, cache: path.join(dir, "cache"), fetchImpl: offline as never, slugs: SLUGS, castVersion: CAST_ENGINE_VERSION })).rejects.toThrow(/does not match its pin/);
    expect(readFileSync(path.join(out, "keep.txt"), "utf8")).toBe("last good");
  });

  it("the index staged must list exactly the pinned parts", () => {
    const idx = fakeIndex([{ speech: 1, pause: 1 }], 1);
    const pins = { parts: [{ file: "part0.webm", sha256: idx.parts[0]!.sha256, bytes: idx.parts[0]!.bytes }] };
    expect(indexMatchesLock(idx, pins)).toEqual([]);
    expect(indexMatchesLock(idx, { parts: [{ ...pins.parts[0]!, bytes: 11 }] })).toEqual(["part 0 differs from the lock"]);
    expect(indexMatchesLock(idx, { parts: [] }).join()).toMatch(/lists 1 parts, the lock 0/);
  });

  it("dial-private's index entries carry every field its gate checks", () => {
    const dir = fakeRender(["cave"]);
    const lock = lockFrom(dir, SLUGS, { castVersion: CAST_ENGINE_VERSION, date: "2026-09-27" });
    const entries = privateIndexEntries(lock, { cave: JSON.parse(readFileSync(path.join(dir, "cave", "manifest.json"), "utf8")) });
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      for (const k of ["work", "file", "sha256", "bytes", "engine", "voice", "asset_url", "rendered_at"]) expect(e[k as keyof typeof e], k).toBeTruthy();
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.asset_url).toMatch(/^https:\/\/github\.com\/aacrit\/dial\/releases\/download\//);
      expect(Number.isInteger(e.bytes) && e.bytes > 0).toBe(true);
    }
  });
});

describe("the committed lock, the staged recordings and the contract", () => {
  const lock = existsSync(path.join(root, "recordings.lock.json")) ? JSON.parse(read("recordings.lock.json")) : null;
  const recorded = Object.entries((lock?.works ?? {}) as Record<string, { recording?: boolean }>)
    .filter(([, w]) => w.recording !== false)
    .map(([s]) => s);

  it("the lock is committed, and sound for this catalogue and cast engine", () => {
    expect(lock, "recordings.lock.json is missing").not.toBeNull();
    expect(lockProblems(lock, SLUGS, CAST_ENGINE_VERSION)).toEqual([]);
  });

  it("the contract checks each recorded work's index and first part, and the list", () => {
    const checks = (parseYaml(read("contract.yaml")) as { checks: { path: string; type: string; expect?: number }[] }).checks;
    const status200 = new Set(checks.filter((c) => c.type === "status" && c.expect === 200).map((c) => c.path));
    expect(status200.has("/recordings/manifest.json")).toBe(true);
    for (const slug of recorded) {
      expect(status200.has(`/recordings/${slug}/index.json`), slug).toBe(true);
      expect(status200.has(`/recordings/${slug}/part0.webm`), slug).toBe(true);
    }
  });

  it("every staged recording is of this text in this cast, line for line (npm run build stages them)", async () => {
    const staged = path.join(root, "web", "public", "recordings");
    expect(existsSync(path.join(staged, "manifest.json")), "web/public/recordings: run npm run build first").toBe(true);
    for (const slug of recorded) {
      const w = WORKS.find((x) => x.slug === slug)!;
      const cues = segment(read(`web/public/works/${slug}.txt`));
      const c = tryCast(cues, w.cast)!;
      const index = JSON.parse(readFileSync(path.join(staged, slug, "index.json"), "utf8")) as RecordingIndex;
      expect(indexProblem(index, { digest: await expectedDigest(cues, c.voices), lines: cues.length, castVersion: CAST_ENGINE_VERSION }), slug).toBeNull();
      // The same pause table as the tab: each line's silence in samples.
      index.lines.forEach((l, i) => expect(l.pause, `${slug} line ${i + 1}`).toBe(Math.round((cues[i]!.pauseAfterMs / 1000) * RECORDING_RATE)));
      for (const p of index.parts) expect(p.bytes, `${slug}/${p.file}`).toBeLessThan(20 * 1024 * 1024);
    }
  });
});

describe("the Seal logs a prepared recording's requests like any other", () => {
  it("names each one in plain words, all from this origin", () => {
    const row = (p: string) => whatItWas({ path: p, own: true, dir: "fetched", event: undefined } as never);
    expect(row("/recordings/manifest.json")).toBe("Dial's recordings: the list");
    expect(row("/recordings/cave/index.json")).toBe("Dial's recording: where each line starts");
    expect(row("/recordings/cave/part0.webm")).toBe("Dial's recording, part 1");
    expect(row("/recordings/cave/part17.webm")).toBe("Dial's recording, part 18");
    // No new origin: the page's fetches of recordings name same-origin paths (tests/no-network.test.ts).
    expect(read("web/src/recording/source.ts")).not.toMatch(/https?:\/\//);
  });
});

describe("the words for a prepared recording", () => {
  it("under Tune in, on air, and at the end", () => {
    expect(PLAYS_AT_ONCE).toBe("Plays at once: Dial made this recording in advance.");
    expect(MAKE_IT_HERE).toMatch(/^Or make it on this device/);
    expect(preparedOnAirLine("Benjamin Jowett")).toBe("Playing a recording Dial made in advance from Jowett's words. Nothing is made or sent while you listen.");
    expect(preparedDoneLine("Crito", 1265)).toBe("Played Dial's recording of Crito to the end, 21:05.");
    // A skip past the end never claims the work was heard to its end.
    expect(preparedSkippedLine("Crito")).toBe("Skipped to the end of Dial's recording of Crito.");
    expect(progressLine({ title: "Crito", heard: 3, made: 252, total: 252, paused: false, renderDone: true, prepared: true })).toBe("On air: Crito, line 3 of 252.");
    for (const s of [PLAYS_AT_ONCE, MAKE_IT_HERE, preparedOnAirLine("George Long"), preparedDoneLine("x", 1)]) expect(s).not.toMatch(/—|render/);
  });

  it("the Bookplate says the recording was made with Kokoro-82M, when, with which engine, and that the words are verbatim", () => {
    const w = WORKS[0]!;
    expect(madeOn("2026-09-27")).toBe("27 September 2026");
    expect(madeOn("junk")).toBe("junk");
    const s = recordingSentence(w, { made: "2026-09-27", cast: "2" }).replace(/<[^>]+>/g, "");
    expect(s).toBe(
      "Dial's recording was made in advance with Kokoro-82M, an open speech model, on 27 September 2026, engine version 2, by the same fixed rules your device uses when you make it there. AI-voiced; the words are Jowett's, verbatim, exactly as printed.",
    );
    expect(bookplateHtml(w, undefined, { made: "2026-09-27", cast: "2" })).toContain("engine version");
    expect(bookplateHtml(w)).not.toContain("made in advance");
    // Escaped: a hostile date never becomes markup.
    expect(recordingSentence(w, { made: '"><img src=x onerror=alert(1)>', cast: "2" })).not.toContain("<img");
  });
});
