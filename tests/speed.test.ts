// T7: the fastest engine, the speed gauge and the no-stall plan. The
// planner's maths, the engine choice and its cache on this device, the
// gauge's figures, the choice past two minutes, and a hold at a line
// boundary, each held without a browser (fake clock, fake scheduler).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { entryFor, gpuOffer, keptChoice, measuredEntry, parseEntry, pickBackend, shapeOf, soundsRight, type SpeedChoice, type SpeedEntry } from "../web/src/speed/backend";
import { GPU_LOST_LINE, HOLD_LINE, MEASURING_LINE, PLAY_RECORDING_NOW, START_ANYWAY, askLine, choiceQuestion, countdownClock, countdownLine, gpuButton, gpuLoadingLine, gpuNoRoomLine, gpuOfferLine, planSentence, valveCountdown, valveResuming } from "../web/src/speed/copy";
import { GAUGE_MAX, engineLabel, engineWords, gaugeName, gaugeReadout, gaugeValueNow, needleAngle, type Gauge } from "../web/src/speed/gauge";
import { NoRoomError, ROOM_MARGIN, downloadGpuModel, gpuOfferAllowed, roomFor, type DownloadDeps } from "../web/src/speed/gpu-model";
import { Pacer, TEST_AHEAD_S, type AskOptions, type PacerHooks } from "../web/src/speed/pacer";
import { GPU_OPEN_MS, RenderLoop, WARM_UP, gpuWatchdogMs, speedTest, type FromWorker, type LoopDeps, type LoopManifest, type Speaker } from "../web/src/speed/render-loop";
import { BENCH_SENTENCE } from "../web/src/bench-sentence";
import { AHEAD_CAP_S, CHOICE_OVER_S, MIN_LEAD_S, PLANNING_MARGIN, aheadLimit, branchFor, leadWait, nextRate, paceScale, planRate, refillLines, type PlanLine } from "../web/src/speed/plan";
import { SPEED_KEY, keepSpeed, readSpeed } from "../web/src/speed/store";
import { GPU_PIN_HEADER, gpuModelKey, heldGpuModel, pinnedModelCache } from "../web/src/voice-files";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** n lines of `speech` seconds each, `pause` of silence after. */
const lines = (n: number, speech: number, pause = 0): PlanLine[] => Array.from({ length: n }, () => ({ speech, pause }));

describe("the no-stall plan (speed/plan.ts)", () => {
  it("plans on 80% of the measured speed, and averages each new line in with weight 0.3", () => {
    expect(PLANNING_MARGIN).toBe(0.8);
    expect(planRate(1.5)).toBeCloseTo(1.2);
    expect(planRate(0)).toBe(0);
    expect(planRate(NaN)).toBe(0);
    // The first line replaces a speed never measured; later lines move it 30% of the way.
    expect(nextRate(0, 4, 2)).toBe(2);
    expect(nextRate(2, 3, 1)).toBeCloseTo(2 + 0.3 * (3 - 2));
    // A line with no time or no speech measures nothing.
    expect(nextRate(1.4, 0, 2)).toBe(1.4);
    expect(nextRate(1.4, 3, 0)).toBe(1.4);
  });

  it("a device slower than real time waits until even the last line is made before playback reaches it", () => {
    // Ten 10 s lines at half real time: 20 s of making each. Line i is made at 20(i+1) s and heard at wait + 10i s.
    expect(leadWait(lines(10, 10), 0, 0, 0.5)).toBeCloseTo(110);
    // The spec's continuous rule, D x (1 / r - 1), is the same plus the last line, which must be whole before it plays.
    const D = 100;
    expect(leadWait(lines(10, 10), 0, 0, 0.5)).toBeCloseTo(D * (1 / 0.5 - 1) + 10);
    // Silence costs no making: pauses stretch playback, so less wait.
    expect(leadWait(lines(10, 10, 5), 0, 0, 0.5)).toBeLessThan(leadWait(lines(10, 10), 0, 0, 0.5));
  });

  it("a device faster than real time waits only for the first MIN_LEAD_S of audio", () => {
    expect(MIN_LEAD_S).toBe(10);
    // 3 s lines at 4x: the lines starting within 10 s (4 of them) are made first, 3 s of making.
    expect(leadWait(lines(100, 3), 0, 0, 4)).toBeCloseTo(3);
    // Every line made: no wait.
    expect(leadWait(lines(5, 3), 5, 0, 4)).toBe(0);
    // Nothing measured yet: no plan (the page measures the first line).
    expect(leadWait(lines(5, 3), 0, 0, 0)).toBe(Infinity);
  });

  it("counts the making already under way, what is made, and where the listener is", () => {
    // Half of the first line's making is already done.
    expect(leadWait(lines(10, 10), 0, 0, 0.5, 10)).toBeCloseTo(100);
    // Five lines made and the listener at the start: the rest must stay ahead of playback.
    const w = leadWait(lines(10, 10), 5, 0, 0.5);
    expect(w).toBeCloseTo(Math.max(...[5, 6, 7, 8, 9].map((i) => 20 * (i - 4) - 10 * i)));
    expect(w).toBeLessThan(leadWait(lines(10, 10), 0, 0, 0.5));
    // A hold: the listener at the end of what is made (50 s) waits less than a fresh start would.
    expect(leadWait(lines(10, 10), 5, 50, 0.5)).toBeCloseTo(60);
  });

  it("estimates the lines not made yet at this voice's own pace, never letting one odd line run the plan", () => {
    expect(paceScale([], [])).toBe(1);
    expect(paceScale([12, 12], [10, 10])).toBeCloseTo(1.2);
    expect(paceScale([100], [10])).toBe(2);
    expect(paceScale([1], [10])).toBe(0.5);
  });

  it("the branch: up to 10 s the valve simply warms, to 2 minutes a countdown, past 2 minutes the choice", () => {
    expect(CHOICE_OVER_S).toBe(120);
    expect(branchFor(0)).toBe("short");
    expect(branchFor(10)).toBe("short");
    expect(branchFor(10.5)).toBe("countdown");
    expect(branchFor(120)).toBe("countdown");
    expect(branchFor(120.5)).toBe("choice");
    expect(branchFor(21 * 60 + 53)).toBe("choice");
    expect(branchFor(Infinity)).toBe("choice");
  });

  it("after 'Start anyway', a hold waits only for the next MIN_LEAD_S, not the whole lead", () => {
    const all = lines(20, 5);
    expect(refillLines(all, 0)).toHaveLength(2);
    expect(refillLines(all, 50)).toHaveLength(12);
    expect(leadWait(refillLines(all, 50), 10, 50, 0.5)).toBeCloseTo(20);
  });

  it("chapter-ahead: making stops at the lower of an hour of audio or 150 MB of it ahead of the listener", () => {
    expect(AHEAD_CAP_S).toBeCloseTo(150_000_000 / 48_000);
    expect(AHEAD_CAP_S).toBeLessThan(3600);
    // A 20-minute work is made whole, ahead of a listener at its start.
    expect(aheadLimit(lines(120, 10), 0)).toBe(119);
    // A two-hour work stops about 52 minutes ahead, and moves on as the listener does.
    const long = lines(720, 10);
    expect(aheadLimit(long, 0)).toBe(Math.floor(AHEAD_CAP_S / 10) - 1);
    expect(aheadLimit(long, 600)).toBe(Math.floor((600 + AHEAD_CAP_S) / 10) - 1);
  });
});

describe("the engine and its cache on this device (speed/backend.ts, speed/store.ts)", () => {
  const pins = { model: "m".repeat(64), runtime: "r".repeat(64) };
  const entry: SpeedEntry = { v: 1, model: pins.model, runtime: pins.runtime, gpu: true, backend: "webgpu", rtf: 7.5, gpuRtf: 7.5 };

  it("picks the fastest engine that ran and speaks right; the processor otherwise", () => {
    expect(pickBackend([{ backend: "wasm", rtf: 1.1, ok: true }, { backend: "webgpu", rtf: 7.5, ok: true }]).backend).toBe("webgpu");
    // Faster but wrong (a quantized operator it cannot run): not chosen.
    expect(pickBackend([{ backend: "wasm", rtf: 1.1, ok: true }, { backend: "webgpu", rtf: 9, ok: false }]).backend).toBe("wasm");
    // Slower: not chosen (the q8 model on WebGPU measured 0.8x on this laptop).
    const slow = pickBackend([{ backend: "wasm", rtf: 1.0, ok: true }, { backend: "webgpu", rtf: 0.8, ok: true }]);
    expect(slow).toEqual({ backend: "wasm", rtf: 1.0, trials: slow.trials, cached: false });
    expect(pickBackend([{ backend: "webgpu", rtf: 0, ok: false }]).backend).toBe("wasm");
  });

  it("the graphics chip counts only if it says the sentence at the processor's length and loudness", () => {
    const ref = shapeOf(new Float32Array(48_000).fill(0.1), 24_000);
    expect(ref).toEqual({ seconds: 2, rms: expect.closeTo(0.1, 6), finite: true });
    expect(soundsRight(shapeOf(new Float32Array(50_000).fill(0.12), 24_000), ref)).toBe(true);
    expect(soundsRight(shapeOf(new Float32Array(60_000).fill(0.1), 24_000), ref)).toBe(false);
    expect(soundsRight(shapeOf(new Float32Array(48_000), 24_000), ref)).toBe(false);
    expect(soundsRight(shapeOf(new Float32Array(48_000).fill(NaN), 24_000), ref)).toBe(false);
  });

  it("uses a kept choice only with the same model, runtime and WebGPU as when it was measured", () => {
    expect(keptChoice(entry, pins, true)).toEqual({ backend: "webgpu", rtf: 7.5, trials: [], cached: true });
    expect(keptChoice(entry, { ...pins, model: "x" }, true)).toBeNull();
    expect(keptChoice(entry, { ...pins, runtime: "x" }, true)).toBeNull();
    expect(keptChoice(entry, pins, false)).toBeNull();
    expect(keptChoice(null, pins, true)).toBeNull();
  });

  it("reads back only a well-formed entry, and keeps the live speed for the engine in use", () => {
    expect(parseEntry(JSON.stringify(entry))).toEqual(entry);
    for (const bad of [null, "", "{", "[]", JSON.stringify({ ...entry, v: 2 }), JSON.stringify({ ...entry, backend: "webnn" }), JSON.stringify({ ...entry, rtf: 0 }), JSON.stringify({ ...entry, rtf: "7" })]) {
      expect(parseEntry(bad), String(bad)).toBeNull();
    }
    const choice: SpeedChoice = { backend: "wasm", rtf: 0, trials: [], cached: false };
    expect(entryFor(choice, pins, true)).toEqual({ v: 1, ...pins, gpu: true, backend: "wasm", rtf: 0 });
    expect(measuredEntry(entryFor(choice, pins, true), "wasm", 1.07)?.rtf).toBe(1.07);
    expect(measuredEntry(entryFor(choice, pins, true), "webgpu", 1.07)).toBeNull();
    expect(measuredEntry(entryFor(choice, pins, true), "wasm", 0)).toBeNull();
  });

  it("the graphics chip's model is answered to the runtime only from its kept copy under the manifest's pin (T11's rule)", async () => {
    const m = { repo: "r", model: "onnx/model_quantized.onnx", gpu: { model: "onnx/model.onnx", sha256: "a".repeat(64) } };
    const store = new Map<string, Response>();
    const cache = { match: async (k: RequestInfo | URL) => store.get(String(k))?.clone(), delete: async () => true };
    let stitched = 0;
    const pc = pinnedModelCache(cache, m, () => undefined, async () => undefined, async () => {
      stitched++;
      return new Response("q8");
    });
    const key = gpuModelKey(m);
    expect(key).toBe("/voice/models/r/onnx/model.onnx");
    // Not on this device: a body that cannot be read, never a fetch, never the q8 stitch.
    await expect((await pc.match(key))!.arrayBuffer()).rejects.toThrow(/not on this device/);
    // Kept under another pin (an older model): refused the same way.
    store.set(key, new Response("old", { headers: { [GPU_PIN_HEADER]: "b".repeat(64) } }));
    await expect((await pc.match(key))!.arrayBuffer()).rejects.toThrow(/not on this device/);
    expect(await heldGpuModel(cache, m)).toBeUndefined();
    // Kept under this pin: answered.
    store.set(key, new Response("fp32", { headers: { [GPU_PIN_HEADER]: m.gpu.sha256 } }));
    expect(await (await pc.match(key))!.text()).toBe("fp32");
    expect(stitched).toBe(0);
  });

  it("offers the graphics chip's model only where WebGPU exists, it is not here yet, and this chip was never tested", () => {
    const bytes = 325_532_232;
    expect(gpuOffer(true, bytes, false, null)).toBe(bytes);
    expect(gpuOffer(false, bytes, false, null)).toBe(0);
    expect(gpuOffer(true, bytes, true, null)).toBe(0);
    expect(gpuOffer(true, undefined, false, null)).toBe(0);
    expect(gpuOffer(true, bytes, false, { ...entry, gpuRtf: 0 })).toBe(0);
    expect(gpuOffer(true, bytes, false, { ...entry, backend: "wasm", gpuRtf: undefined })).toBe(bytes);
  });

  describe("kept in local storage under one key, and a blocked storage only means testing again", () => {
    const g = globalThis as { window?: unknown };
    afterEach(() => {
      delete g.window;
    });

    it("writes and reads the entry", () => {
      const store = new Map<string, string>();
      g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } };
      expect(readSpeed()).toBeNull();
      keepSpeed(entry);
      expect([...store.keys()]).toEqual([SPEED_KEY]);
      expect(SPEED_KEY).toBe("dial.speed");
      expect(readSpeed()).toEqual(entry);
    });

    it("storage that throws is none", () => {
      g.window = {
        get localStorage(): Storage {
          throw new Error("SecurityError");
        },
      };
      expect(readSpeed()).toBeNull();
      expect(() => keepSpeed(entry)).not.toThrow();
    });
  });
});

describe("the gauge's figures (speed/gauge.ts) and the plan's words (speed/copy.ts)", () => {
  it("shows the measured real-time factor with its engine named plainly", () => {
    expect(gaugeReadout(1.8)).toBe("1.8× real time");
    expect(gaugeReadout(0.94)).toBe("0.94× real time");
    expect(gaugeReadout(16.69)).toBe("16.7× real time");
    expect(gaugeReadout(0)).toBe("Measuring");
    expect(gaugeReadout(NaN)).toBe("Measuring");
    expect(engineLabel("wasm")).toBe("Processor");
    expect(engineLabel("webgpu")).toBe("Graphics chip");
    expect(engineWords("wasm")).toBe("this device's processor");
    expect(engineWords("webgpu")).toBe("this device's graphics chip");
    expect(gaugeName(1.8, "webgpu")).toBe("Speed of this device: 1.8× real time, on this device's graphics chip");
    expect(gaugeName(0, "wasm")).toBe("Speed of this device: not measured yet, on this device's processor");
  });

  it("the needle spans 0 to 4x and pins at both ends; the figure still says how fast", () => {
    expect(GAUGE_MAX).toBe(4);
    expect(needleAngle(0)).toBe(-60);
    expect(needleAngle(1)).toBe(-30);
    expect(needleAngle(4)).toBe(60);
    expect(needleAngle(16.7)).toBe(60);
    expect(needleAngle(-1)).toBe(-60);
  });

  it("the countdown reads m:ss, rounded up, so it never says 0:00 while there is a wait", () => {
    expect(countdownClock(42)).toBe("0:42");
    expect(countdownClock(41.2)).toBe("0:42");
    expect(countdownClock(303)).toBe("5:03");
    expect(countdownClock(3723)).toBe("1:02:03");
    expect(countdownClock(0.3)).toBe("0:01");
    // CoS decision O: a forecast at four fifths of the measured speed, never a promise. The words say "four fifths": the margin they name is pinned here.
    expect(PLANNING_MARGIN).toBe(4 / 5);
    expect(countdownLine(42)).toBe("Starting in 0:42. Planned at four fifths of this device's speed, so it should not pause.");
    expect(countdownLine(8, true)).toBe("Starting in 0:08.");
    expect(countdownLine(42)).not.toMatch(/never|won't/);
    expect(valveResuming(12)).toBe("Resuming in 0:12");
    expect(valveCountdown(303)).toBe("Starting in 5:03");
  });

  it("says the measured speed, the engine and the planned speed, and where each figure came from", () => {
    const now: SpeedChoice = { backend: "webgpu", rtf: 7.5, trials: [{ backend: "wasm", rtf: 1.1, ok: true }, { backend: "webgpu", rtf: 7.5, ok: true }], cached: false };
    expect(planSentence(now, 7.5, planRate(7.5))).toBe("This device makes speech at 7.5× real time on this device's graphics chip (1.1× on its processor), measured just now. Dial plans on 6.0× to be safe.");
    expect(planSentence({ backend: "wasm", rtf: 0, trials: [], cached: false }, 1.07, planRate(1.07))).toBe("This device makes speech at 1.1× real time on this device's processor, measured from its first line. Dial plans on 0.86× to be safe.");
    expect(planSentence({ backend: "wasm", rtf: 1, trials: [], cached: true }, 1, 0.8)).toContain("as measured on an earlier listen");
  });

  it("the choice past two minutes and the graphics chip's offer state the wait and the size, and no em dash anywhere", () => {
    // The wait is making time, not audio.
    expect(choiceQuestion(33 * 60 + 33, true)).toBe("To play without a pause, this device needs 33:33 of making before it starts. Dial's own recording can play now instead.");
    expect(choiceQuestion(150, false)).toBe("To play without a pause, this device needs 2:30 of making before it starts. You can wait, or start now and let it pause when it needs to.");
    expect(gpuNoRoomLine(325_532_232)).toBe("There is not enough free space on this device for the graphics chip's voice (about 326 MB), so the processor carries on. Free some space, then try again.");
    expect(gpuOfferLine(325_532_232)).toContain("about 326 MB, downloaded once and kept on this device");
    expect(gpuButton(325_532_232)).toBe("Test the graphics chip (about 326 MB)");
    expect(gpuLoadingLine(48_200_000, 325_532_232)).toBe("Downloading the graphics chip's voice: 48 of 326 MB. The processor keeps making the work meanwhile.");
    expect(askLine({ wait: 30, choice: false, hasRecording: true, gpuBytes: 0 })).toBe("");
    expect(PLAY_RECORDING_NOW).toBe("Play Dial's recording now");
    expect(START_ANYWAY).toBe("Start anyway; it may pause");
    expect(HOLD_LINE).toBe("Making the next line…");
    const html = read("web/index.html");
    expect(html).toContain(`<button type="button" class="btn" id="speed-rec">${PLAY_RECORDING_NOW.replace("'", "'")}</button>`);
    expect(html).toContain(`id="speed-anyway">${START_ANYWAY}</button>`);
    for (const s of [choiceQuestion(200, true), choiceQuestion(200, false), gpuOfferLine(1e8), gpuLoadingLine(1, 2), HOLD_LINE, MEASURING_LINE, countdownLine(9)]) expect(s).not.toMatch(/—/);
    for (const f of ["web/src/speed/copy.ts", "web/src/speed/gauge.ts"]) expect(read(f), f).not.toMatch(/—/);
  });
});

// ---- The pacer, on a fake clock and a fake scheduler ---------------------------------------

interface Rig {
  pacer: Pacer;
  clock: { t: number };
  audio: { state: string; suspends: number; resumes: number };
  sched: { made: number; madeSeconds: number; speech: number[]; lengths: number[]; pos: number };
  said: string[];
  asks: { question: string; options: AskOptions }[];
  hidden: number;
  gauge: { shown: string[]; values: number[] };
  gpuAsks: number;
  gpuSends: number;
  gpuCancels: number;
}

/** A work of `n` lines, each `words` words (about `words` x 60/155 s of speech) with no pause. */
function rig(n: number, words: number, hasRecording: boolean): Rig {
  const clock = { t: 0 };
  const audio = {
    state: "running",
    suspends: 0,
    resumes: 0,
    suspend() {
      this.state = "suspended";
      this.suspends++;
      return Promise.resolve();
    },
    resume() {
      this.state = "running";
      this.resumes++;
      return Promise.resolve();
    },
  };
  const sched = {
    made: 0,
    speech: [] as number[],
    lengths: [] as number[],
    pos: 0,
    get madeSeconds() {
      return this.lengths.reduce((a, b) => a + b, 0);
    },
    position() {
      return this.pos;
    },
  };
  const r: Rig = { clock, audio, sched, said: [], asks: [], hidden: 0, gauge: { shown: [], values: [] }, gpuAsks: 0, gpuSends: 0, gpuCancels: 0, pacer: null! };
  const gauge: Gauge = { show: (b) => void r.gauge.shown.push(b), set: (x) => void r.gauge.values.push(x), hide: () => undefined };
  const hooks: PacerHooks = {
    cues: Array.from({ length: n }, () => ({ spoken: Array.from({ length: words }, () => "word").join(" "), pauseAfterMs: 0 })),
    sched,
    audio,
    gauge,
    hasRecording: () => hasRecording,
    playRecording: () => r.said.push("recording"),
    announce: (line) => void r.said.push(line),
    setValve: () => undefined,
    showAsk: (question, options) => void r.asks.push({ question, options }),
    hideAsk: () => void r.hidden++,
    repaint: () => undefined,
    allow: () => undefined,
    askGpu: () => {
      r.gpuAsks++;
      return () => void r.gpuCancels++;
    },
    sendGpu: () => void r.gpuSends++,
    keep: () => undefined,
    setPauseLabel: () => undefined,
    resumed: () => void r.said.push("resumed"),
    now: () => clock.t,
  };
  r.pacer = new Pacer(hooks);
  return r;
}

/** The worker makes a line of `speech` seconds in `work` seconds. */
function make(r: Rig, speech: number, work: number) {
  r.clock.t += work;
  r.sched.speech.push(speech);
  r.sched.lengths.push(speech);
  r.sched.made++;
  r.pacer.cue(speech, work);
}

const choiceOf = (rtf: number): SpeedChoice => ({ backend: "wasm", rtf, trials: [], cached: true });
const entryOf = (rtf: number): SpeedEntry => ({ v: 1, model: "m", runtime: "r", gpu: false, backend: "wasm", rtf });

describe("the pacer (speed/pacer.ts): the countdown, the choice past two minutes, and a hold", () => {
  it("holds playback from the start, and starts once the lead is made on a fast device", () => {
    const r = rig(60, 30, true);
    // Playback is held from the first moment: the audio clock is suspended.
    expect(r.audio.state).toBe("suspended");
    r.pacer.speed(choiceOf(4), entryOf(4), 0);
    r.pacer.ready();
    expect(r.pacer.waiting).toBe(true);
    expect(r.asks).toEqual([]);
    // Four lines of about 11.6 s made at 4x: the first 10 s are more than covered.
    make(r, 11.6, 2.9);
    expect(r.pacer.waiting).toBe(false);
    expect(r.audio.resumes).toBe(1);
  });

  it("past two minutes: the choice, Dial's recording first where there is one", () => {
    // Sixty 11.6 s lines (about 11.6 minutes) on a device measured at 0.6x: planned at 0.48x, far over two minutes.
    const r = rig(60, 30, true);
    r.pacer.speed(choiceOf(0.6), entryOf(0.6), 0);
    r.pacer.ready();
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]!.options).toEqual({ recording: true, anyway: true, gpuBytes: 0 });
    expect(r.asks[0]!.question).toMatch(/^To play without a pause, this device needs \d+:\d\d of making before it starts\. Dial's own recording can play now instead\.$/);
    expect(r.pacer.progressLine()).toMatch(/^Starting in \d+:\d\d\. Planned at four fifths of this device's speed, so it should not pause\.$/);
    // Dial's recording, chosen.
    r.pacer.playRecording();
    expect(r.said.at(-1)).toBe("recording");
  });

  it("past two minutes with no recording: wait, or start anyway; starting anyway plays at once", () => {
    const r = rig(60, 30, false);
    r.pacer.speed(choiceOf(0.6), entryOf(0.6), 0);
    r.pacer.ready();
    expect(r.asks[0]!.options).toEqual({ recording: false, anyway: true, gpuBytes: 0 });
    expect(r.asks[0]!.question).toContain("You can wait, or start now");
    make(r, 11.6, 19);
    expect(r.pacer.waiting).toBe(true);
    r.pacer.startAnyway();
    expect(r.pacer.waiting).toBe(false);
    expect(r.audio.state).toBe("running");
  });

  it("under two minutes: a countdown only, and the graphics chip offered with its size where there is one", () => {
    const r = rig(20, 30, true);
    r.pacer.speed(choiceOf(0.9), entryOf(0.9), 325_532_232);
    r.pacer.ready();
    const wait = leadWait(lines(20, 30 / 155 * 60), 0, 0, planRate(0.9));
    expect(branchFor(wait)).toBe("countdown");
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]!.options).toEqual({ recording: false, anyway: false, gpuBytes: 325_532_232 });
    expect(r.asks[0]!.question).toBe(gpuOfferLine(325_532_232));
  });

  it("the listener catches the making: playback holds at the line boundary, says so, and plans again", () => {
    const r = rig(40, 30, false);
    r.pacer.speed(choiceOf(4), entryOf(4), 0);
    r.pacer.ready();
    make(r, 11.6, 2.9);
    expect(r.pacer.waiting).toBe(false);
    // The device slows down: the listener reaches the end of what is made while line 2 is still being made.
    r.sched.pos = r.sched.madeSeconds;
    r.clock.t += 11.6;
    r.pacer.tick();
    expect(r.pacer.waiting).toBe(true);
    expect(r.audio.state).toBe("suspended");
    expect(r.said).toContain(HOLD_LINE);
    // CoS decision O: a hold says only what it is doing, never a countdown promise.
    // Said once, in the announced status; the line under it keeps the broadcast's own progress (not "Paused").
    expect(r.pacer.progressLine()).toBeNull();
    expect(read("web/src/main.ts")).toContain('paused: s.audio.state === "suspended" && !s.pacer?.waiting,');
    // It resumes at the next line boundary once the plan holds again.
    make(r, 11.6, 2.9);
    make(r, 11.6, 2.9);
    expect(r.pacer.waiting).toBe(false);
    expect(r.audio.state).toBe("running");
    // The page says it is on air again.
    expect(r.said.at(-1)).toBe("resumed");
  });

  it("Pause pressed during the wait only stops playback starting by itself", () => {
    const r = rig(60, 30, false);
    r.pacer.speed(choiceOf(4), entryOf(4), 0);
    r.pacer.ready();
    expect(r.pacer.pausePressed()).toBe(true);
    make(r, 11.6, 2.9);
    expect(r.pacer.waiting).toBe(false);
    expect(r.audio.state).toBe("suspended");
    // Once playing, Pause is the page's own again.
    expect(r.pacer.pausePressed()).toBe(false);
  });

  it("with no speed known yet, the first line measures it before any plan is said", () => {
    const r = rig(60, 30, false);
    r.pacer.speed({ backend: "wasm", rtf: 0, trials: [], cached: false }, entryOf(1), 0);
    r.pacer.ready();
    expect(r.said).toEqual([MEASURING_LINE]);
    make(r, 11.6, 10.5);
    expect(r.said.at(-1)).toMatch(/^This device makes speech at 1\.1× real time on this device's processor, measured from its first line\./);
    expect(r.gauge.values.at(-1)).toBeCloseTo(11.6 / 10.5);
  });
});

describe("the page and the worker keep to the plan (source checks)", () => {
  const main = read("web/src/main.ts");
  const worker = read("web/src/narrate.worker.ts");

  it("the worker runs the tested loop with the real engines, and the page measures from the worker's own timing", () => {
    expect(worker).toMatch(/const loop = new RenderLoop\(\{/);
    expect(worker).toMatch(/ctx\.onmessage = \(event\) => loop\.onMessage\(event\.data\);/);
    expect(worker).toMatch(/return !!\(await gpu\.requestAdapter\(\)\);/);
    expect(read("web/src/speed/render-loop.ts")).toMatch(/while \(i > this\.allowed\) await new Promise<void>/);
    expect(main).toMatch(/own\.pacer\?\.cue\(speech, msg\.ms \/ 1000\);/);
    // The offer passes the device gate; the model goes to the worker only through the pacer's safe moment.
    expect(main).toMatch(/gpuOfferAllowed\(navigator as DeviceHints, matchMedia\("\(pointer: coarse\) and \(max-width: 900px\)"\)\.matches\) \? msg\.gpuOffer : 0/);
    expect(main).toMatch(/if \(m\.type === "done"\) own\.pacer\?\.gpuReady\(\);/);
    expect([...main.matchAll(/type: "gpu" \}/g)]).toHaveLength(1);
    expect(main).toMatch(/sendGpu: \(\) => own\.worker\?\.postMessage\(\{ type: "gpu" \} satisfies ToWorker\),/);
  });

  it("the gauge shows only while this device makes the work; Dial's recording never builds a pacer", () => {
    expect(main).toMatch(/if \(worker\) \{\s*const mine = \(\) => session === own && own\.live;\s*own\.pacer = new Pacer\(/);
    expect(main).toMatch(/const worker = rec \? null : new Worker\(/);
    expect(read("web/src/speed/pacer.ts")).toMatch(/done\(\): void \{[\s\S]*?this\.h\.gauge\.hide\(\);/);
    expect(read("web/src/speed/gauge.ts")).toMatch(/if \(motion\.reduce \|\| slot\.hidden\) \{\s*spring\.snap\(\);/);
    // While the gauge shows (making here), the make-it-here link gives its room to the panel (CI's 375x812 overflow, T7).
    expect(read("web/src/style.css")).toMatch(/\.device:has\(#speed-gauge:not\(\[hidden\]\)\) #make-here \{\s*display: none;\s*\}/);
    // A meter, like the Voice meter.
    const gauge = read("web/src/speed/gauge.ts");
    for (const a of ['setAttribute("role", "meter")', 'setAttribute("aria-valuemin", "0")', 'setAttribute("aria-valuemax", String(GAUGE_MAX))', 'setAttribute("aria-valuenow", gaugeValueNow(rtf))', 'setAttribute("aria-valuetext", gaugeName(rtf, backend))']) expect(gauge).toContain(a);
    expect(gaugeValueNow(1.234)).toBe("1.23");
    expect(gaugeValueNow(16.7)).toBe("4");
    expect(gaugeValueNow(NaN)).toBe("0");
  });
});

// ---- The graphics chip: who is offered it, the download, when it is tested ---------------

const BYTES = 325_532_232;

describe("the graphics chip's 326 MB model: offered only where it fits (speed/gpu-model.ts)", () => {
  it("is offered only with 8 GB or more reported, never on a phone", () => {
    expect(gpuOfferAllowed({ deviceMemory: 8 }, false)).toBe(true);
    expect(gpuOfferAllowed({ deviceMemory: 8, userAgentData: { mobile: false } }, true)).toBe(true);
    expect(gpuOfferAllowed({ deviceMemory: 4 }, false)).toBe(false);
    // No memory reported (Firefox, Safari): not offered.
    expect(gpuOfferAllowed({}, false)).toBe(false);
    expect(gpuOfferAllowed({ deviceMemory: 8, userAgentData: { mobile: true } }, false)).toBe(false);
    // No mobile hint: a coarse pointer on a small screen counts as a phone.
    expect(gpuOfferAllowed({ deviceMemory: 8 }, true)).toBe(false);
  });

  it("needs its size plus a tenth free; no estimate leaves it to the write", () => {
    expect(ROOM_MARGIN).toBe(1.1);
    expect(roomFor(BYTES, { quota: 1e9, usage: 0 })).toBe(true);
    expect(roomFor(BYTES, { quota: BYTES * 1.05, usage: 0 })).toBe(false);
    expect(roomFor(BYTES, { quota: 2e9, usage: 2e9 - BYTES })).toBe(false);
    expect(roomFor(BYTES, null)).toBe(true);
  });

  /** A fake origin and cache: parts of 3 and 2 bytes, pinned by a fake hash of their length. */
  function origin(opts: { quota?: number; badPart?: number } = {}) {
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const manifest = { repo: "r", revision: "rev", sha256: "q".repeat(64), runtime: "x", runtimeSha256: "y", model: "onnx/model_quantized.onnx", parts: [], sizes: {}, gpu: { model: "onnx/model.onnx", sha256: "g".repeat(64), parts: ["model.part0", "model.part1"], partSha256: ["h3", "h2"], bytes: 5 } };
    const fetched: string[] = [];
    const store = new Map<string, Uint8Array>();
    const deleted: string[] = [];
    const deps: DownloadDeps = {
      fetch: (async (url: string) => {
        fetched.push(url);
        if (url === "/voice/manifest.json") return new Response(JSON.stringify(manifest));
        const i = manifest.gpu.parts.findIndex((p) => url.endsWith(p));
        return new Response(i === opts.badPart ? new Uint8Array([9, 9, 9]) : parts[i]!);
      }) as typeof fetch,
      open: async () => ({
        put: async (key: RequestInfo | URL, res: Response) => void store.set(String(key), new Uint8Array(await res.arrayBuffer())),
        delete: async (key: RequestInfo | URL) => {
          deleted.push(String(key));
          return store.delete(String(key));
        },
      }),
      estimate: async () => ({ quota: opts.quota ?? 1e9, usage: 0 }),
      sha256: async (buf) => `h${buf.byteLength}`,
    };
    return { deps, fetched, store, deleted };
  }

  it("streams the parts into the cache one at a time, each checked, with the whole's pin beside it", async () => {
    const o = origin();
    const seen: number[] = [];
    await downloadGpuModel((loaded) => seen.push(loaded), o.deps);
    expect(o.fetched).toEqual(["/voice/manifest.json", "/voice/models/r/onnx/model.part0", "/voice/models/r/onnx/model.part1"]);
    expect([...o.store.get("/voice/models/r/onnx/model.onnx")!]).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([0, 3, 5]);
    // Any copy under an older pin goes first.
    expect(o.deleted[0]).toBe("/voice/models/r/onnx/model.onnx");
    expect(read("web/src/speed/gpu-model.ts")).toMatch(/new Response\(body, \{ headers: \{[^}]*\[GPU_PIN_HEADER\]: gpu\.sha256 \} \}\)/);
  });

  it("a part that fails its pin keeps nothing", async () => {
    const o = origin({ badPart: 1 });
    await expect(downloadGpuModel(() => undefined, o.deps)).rejects.toThrow(/pin/);
    expect(o.store.size).toBe(0);
  });

  it("no room: nothing is fetched past the manifest, and the error says so", async () => {
    const o = origin({ quota: 5 });
    await expect(downloadGpuModel(() => undefined, o.deps)).rejects.toBeInstanceOf(NoRoomError);
    expect(o.fetched).toEqual(["/voice/manifest.json"]);
  });
});

describe("the pacer and the graphics chip: offered once, downloaded on the listener's key, tested at a safe moment", () => {
  it("offers it with a real countdown, downloads only on the key, and sends it at once while playback waits", () => {
    const r = rig(60, 30, false);
    r.pacer.speed(choiceOf(0.9), entryOf(0.9), BYTES);
    r.pacer.ready();
    expect(r.asks).toHaveLength(1);
    expect(r.asks[0]!.options.gpuBytes).toBe(BYTES);
    expect(r.gpuAsks).toBe(0);
    r.pacer.testGpu();
    expect(r.gpuAsks).toBe(1);
    // The download's progress beside the countdown's time.
    r.pacer.tick();
    expect(r.pacer.progressLine()).toMatch(/^Starting in \d+:\d\d\. Graphics chip's voice: 0 of 326 MB\.$/);
    // Pressing the key again downloads nothing more.
    r.pacer.testGpu();
    expect(r.gpuAsks).toBe(1);
    expect(r.gpuSends).toBe(0);
    r.pacer.gpuReady();
    expect(r.gpuSends).toBe(1);
  });

  it("while playing, it is sent only once 30 s are made ahead of the listener", () => {
    expect(TEST_AHEAD_S).toBe(30);
    const r = rig(60, 30, false);
    r.pacer.speed(choiceOf(4), entryOf(4), BYTES);
    r.pacer.ready();
    make(r, 11.6, 2.9);
    expect(r.pacer.waiting).toBe(false);
    r.pacer.testGpu();
    r.pacer.gpuReady();
    expect(r.gpuSends).toBe(0);
    make(r, 11.6, 2.9);
    r.sched.pos = 2;
    r.pacer.tick();
    // 21.2 s ahead: not yet.
    expect(r.gpuSends).toBe(0);
    make(r, 11.6, 2.9);
    // 32.8 s ahead: the test's pause cannot be heard.
    expect(r.gpuSends).toBe(1);
  });

  it("plans again once the test has switched the engine", () => {
    const r = rig(60, 30, true);
    r.pacer.speed(choiceOf(0.6), entryOf(0.6), 0);
    r.pacer.ready();
    make(r, 11.6, 19);
    expect(r.pacer.waiting).toBe(true);
    const tested: SpeedChoice = { backend: "webgpu", rtf: 8, trials: [{ backend: "wasm", rtf: 0.6, ok: true }, { backend: "webgpu", rtf: 8, ok: true }], cached: false };
    r.pacer.speed(tested, { ...entryOf(8), backend: "webgpu", gpuRtf: 8 }, 0);
    expect(r.gauge.shown.at(-1)).toBe("webgpu");
    expect(r.said.at(-1)).toMatch(/on this device's graphics chip \(0\.60× on its processor\), measured just now/);
    // At 8x the made line covers the first 10 s: playback starts.
    expect(r.pacer.waiting).toBe(false);
  });

  it("is offered once a visit: a later hold does not offer it again", () => {
    const r = rig(60, 30, false);
    r.pacer.speed(choiceOf(0.9), entryOf(0.9), BYTES);
    r.pacer.ready();
    make(r, 11.6, 12);
    r.pacer.startAnyway();
    r.sched.pos = r.sched.madeSeconds;
    r.pacer.tick();
    expect(r.pacer.waiting).toBe(true);
    expect(r.asks.slice(1).every((a) => a.options.gpuBytes === 0)).toBe(true);
    expect(r.asks.filter((a) => a.options.gpuBytes > 0)).toHaveLength(1);
  });

  it("a graphics chip the browser stops is said plainly, and the gauge moves to the processor", () => {
    const r = rig(60, 30, false);
    r.pacer.speed({ backend: "webgpu", rtf: 12, trials: [], cached: true }, { ...entryOf(12), backend: "webgpu" }, 0);
    r.pacer.ready();
    make(r, 11.6, 1);
    r.pacer.speed({ backend: "wasm", rtf: 0, trials: [], cached: false }, entryOf(1), 0);
    expect(r.said.at(-1)).toBe(GPU_LOST_LINE);
    expect(r.gauge.shown.at(-1)).toBe("wasm");
    // Its speed is measured afresh from the processor's next line.
    make(r, 11.6, 10.5);
    expect(r.gauge.values.at(-1)).toBeCloseTo(11.6 / 10.5);
  });

  it("while the speed test runs, nothing is made, so the countdown holds still instead of running down", () => {
    const r = rig(60, 30, false);
    r.pacer.speed(choiceOf(0.9), entryOf(0.9), 0);
    r.pacer.ready();
    make(r, 11.6, 13);
    r.pacer.testing();
    r.pacer.tick();
    const before = r.pacer.progressLine();
    r.clock.t += 10;
    r.pacer.tick();
    expect(r.pacer.progressLine()).toBe(before);
    // Without a test running, the same 10 s run the countdown down.
    const s = rig(60, 30, false);
    s.pacer.speed(choiceOf(0.9), entryOf(0.9), 0);
    s.pacer.ready();
    make(s, 11.6, 13);
    s.pacer.tick();
    const was = s.pacer.progressLine();
    s.clock.t += 10;
    s.pacer.tick();
    expect(s.pacer.progressLine()).not.toBe(was);
  });

  it("the graphics chip's download stops when the broadcast does", () => {
    const r = rig(60, 30, false);
    r.pacer.speed(choiceOf(0.9), entryOf(0.9), BYTES);
    r.pacer.ready();
    r.pacer.testGpu();
    r.pacer.dispose();
    expect(r.gpuCancels).toBe(1);
    expect(read("web/src/main.ts")).toMatch(/dl\.postMessage\("start"\);\s*\/\/[^\n]*\n\s*return end;/);
  });

  it("a failed download says why, and names the fix when there was no room", () => {
    const r = rig(60, 30, false);
    r.pacer.speed(choiceOf(0.9), entryOf(0.9), BYTES);
    r.pacer.ready();
    r.pacer.testGpu();
    r.pacer.gpuFailed(true);
    expect(r.said.at(-1)).toBe(gpuNoRoomLine(BYTES));
  });
});

// ---- The render loop (speed/render-loop.ts) with fake engines ------------------------------

interface FakeEngine extends Speaker {
  calls: string[];
  disposed: number;
}

/** An engine that makes `rtf` seconds of speech per second on the fake clock; `failAt`: its nth call throws (a lost device); `wrong`: it says things at the wrong length. */
function engine(clock: { ms: number }, rtf: number, opts: { failAt?: number; hangAt?: number; wrong?: boolean } = {}): FakeEngine {
  const e: FakeEngine = {
    calls: [],
    disposed: 0,
    model: { dispose: () => void e.disposed++ },
    async generate(text: string) {
      e.calls.push(text);
      if (opts.failAt !== undefined && e.calls.length === opts.failAt) throw new Error("GPUDeviceLostError: lost");
      // A crashed GPU process: the call is never answered.
      if (opts.hangAt !== undefined && e.calls.length === opts.hangAt) return new Promise<never>(() => undefined);
      const seconds = (text.length / 15) * (opts.wrong ? 1.5 : 1);
      clock.ms += (seconds / rtf) * 1000;
      return { audio: new Float32Array(Math.round(seconds * 100)).fill(0.1), sampling_rate: 100 };
    },
  };
  return e;
}

function loopRig(opts: { held: boolean; gpuRtf: number; gpuFailAt?: number; gpuHangAt?: number; gpuOpenHangs?: boolean; gpuWrong?: boolean; kept?: SpeedEntry | null }) {
  const clock = { ms: 0 };
  const cpu = engine(clock, 1);
  const gpu = engine(clock, opts.gpuRtf, { failAt: opts.gpuFailAt, hangAt: opts.gpuHangAt, wrong: opts.gpuWrong });
  const reopened: FakeEngine[] = [];
  const msgs: FromWorker[] = [];
  const opened: string[] = [];
  const state = { held: opts.held, drops: 0, cpuOpened: true, watchdogs: [] as number[] };
  const manifest: LoopManifest = { sha256: "m", runtimeSha256: "r", voices: { am_michael: "p" }, gpu: { bytes: BYTES } };
  let loop: RenderLoop<LoopManifest>;
  const deps: LoopDeps<LoopManifest> = {
    loadVoice: async (_v, _p, openCpu) => {
      state.cpuOpened = openCpu;
      return { tts: openCpu ? cpu : null, manifest, kept: true };
    },
    openVoice: async (_m, backend) => {
      opened.push(backend);
      // A graphics chip whose session never finishes opening.
      if (backend === "webgpu" && opts.gpuOpenHangs) return new Promise<never>(() => undefined);
      if (backend === "webgpu") return gpu;
      const again = engine(clock, 1);
      reopened.push(again);
      return again;
    },
    gpuModelHeld: async () => state.held,
    dropGpuModel: async () => {
      state.drops++;
      state.held = false;
    },
    hasGpu: async () => true,
    post: (m) => void msgs.push(m),
    flushRequests: () => undefined,
    turn: () => Promise.resolve(),
    // The watchdog fires on the next task: a line that answers (in microtasks) always wins the race.
    sleep: (ms) => {
      state.watchdogs.push(ms);
      return new Promise((resolve) => setTimeout(resolve, 0));
    },
    now: () => clock.ms,
  };
  loop = new RenderLoop(deps);
  const cues = ["The first line of the work.", "The second line, a little longer than the first.", "A third."].map((spoken, i) => ({ spoken, text: spoken, start: i, end: i + 1, pauseAfterMs: 0 }));
  const run = () => loop.render({ type: "render", cues: cues as never, voices: ["am_michael", "am_michael", "am_michael"] as never, kept: opts.kept ?? null });
  return { loop, run, msgs, opened, state, cpu, gpu, reopened, deps, manifest };
}

const cuesMade = (msgs: FromWorker[]) => msgs.filter((m) => m.type === "cue").map((m) => (m as { index: number }).index);

describe("the render loop: the engine choice, as behaviour", () => {
  it("never downloads or opens the graphics chip on its own: without its model it offers the size and makes on the processor", async () => {
    const r = loopRig({ held: false, gpuRtf: 10 });
    await r.run();
    expect(r.opened).toEqual([]);
    const speed = r.msgs.find((m) => m.type === "speed") as Extract<FromWorker, { type: "speed" }>;
    expect(speed.choice.backend).toBe("wasm");
    expect(speed.gpuOffer).toBe(BYTES);
    expect(r.msgs.some((m) => m.type === "testing")).toBe(false);
    expect(cuesMade(r.msgs)).toEqual([0, 1, 2]);
    // Measured from its first line, after a warm-up phrase.
    expect(r.cpu.calls[0]).toBe(WARM_UP);
  });

  it("a graphics chip that loses is let go and its model deleted from this device", async () => {
    const r = loopRig({ held: true, gpuRtf: 0.5 });
    await r.run();
    expect(r.cpu.calls).toContain(BENCH_SENTENCE);
    expect(r.gpu.calls).toContain(BENCH_SENTENCE);
    expect(r.state.drops).toBe(1);
    expect(r.gpu.disposed).toBe(1);
    const speed = r.msgs.find((m) => m.type === "speed") as Extract<FromWorker, { type: "speed" }>;
    expect(speed.choice.backend).toBe("wasm");
    expect(speed.entry.gpuRtf).toBeCloseTo(0.5);
    expect(cuesMade(r.msgs)).toEqual([0, 1, 2]);
  });

  it("one that says the sentence wrongly is refused and deleted, however fast", async () => {
    const r = loopRig({ held: true, gpuRtf: 20, gpuWrong: true });
    await r.run();
    expect(r.state.drops).toBe(1);
    expect((r.msgs.find((m) => m.type === "speed") as Extract<FromWorker, { type: "speed" }>).entry.gpuRtf).toBe(0);
  });

  it("one that wins makes the work; the processor's session is never let go while it runs (that breaks WebGPU)", async () => {
    const r = loopRig({ held: true, gpuRtf: 10 });
    await r.run();
    const speed = r.msgs.find((m) => m.type === "speed") as Extract<FromWorker, { type: "speed" }>;
    expect(speed.choice.backend).toBe("webgpu");
    expect(r.state.drops).toBe(0);
    expect(r.cpu.disposed).toBe(0);
    expect(r.gpu.calls.filter((c) => c !== WARM_UP && c !== BENCH_SENTENCE)).toHaveLength(3);
  });

  const keptGpu: SpeedEntry = { v: 1, model: "m", runtime: "r", gpu: true, backend: "webgpu", rtf: 14, gpuRtf: 12 };

  it("a later visit on a device that chose its graphics chip never opens the processor's session", async () => {
    const r = loopRig({ held: true, gpuRtf: 10, kept: keptGpu });
    await r.run();
    expect(r.state.cpuOpened).toBe(false);
    expect(r.opened).toEqual(["webgpu"]);
    expect(r.cpu.calls).toEqual([]);
    expect(r.msgs.some((m) => m.type === "testing")).toBe(false);
    expect(cuesMade(r.msgs)).toEqual([0, 1, 2]);
  });

  it("a graphics chip the browser stops: this worker says where, and a fresh one carries on from that line on the processor, untested", async () => {
    // Its calls: line 1, then line 2 fails.
    const r = loopRig({ held: true, gpuRtf: 10, gpuFailAt: 2, kept: keptGpu });
    await r.run();
    expect(r.opened).toEqual(["webgpu"]);
    const speeds = r.msgs.filter((m) => m.type === "speed") as Extract<FromWorker, { type: "speed" }>[];
    expect(speeds.map((s) => s.choice.backend)).toEqual(["webgpu", "wasm"]);
    expect(speeds[1]!.entry.gpu).toBe(false);
    expect(cuesMade(r.msgs)).toEqual([0]);
    const lost = r.msgs.at(-1) as Extract<FromWorker, { type: "lost" }>;
    expect(lost.type).toBe("lost");
    expect(lost.index).toBe(1);
    expect(r.gpu.disposed).toBe(1);
    // The fresh worker (a new loop, the same device): the processor from line 2, no test, no second session.
    const again = loopRig({ held: true, gpuRtf: 10 });
    await again.loop.render({ type: "render", cues: [{ spoken: "a", text: "a", start: 0, end: 1, pauseAfterMs: 0 }, { spoken: "The second line.", text: "b", start: 1, end: 2, pauseAfterMs: 0 }] as never, voices: ["am_michael", "am_michael"] as never, from: lost.index, kept: { ...lost.kept, model: "m", runtime: "r" } });
    expect(again.msgs.some((m) => m.type === "testing")).toBe(false);
    expect(again.opened).toEqual([]);
    expect(cuesMade(again.msgs)).toEqual([1]);
  });

  it("a graphics chip that stops answering (a crashed GPU process) is treated as stopped after its watchdog", async () => {
    const r = loopRig({ held: true, gpuRtf: 10, gpuHangAt: 2, kept: keptGpu });
    await r.run();
    expect(r.msgs.at(-1)?.type).toBe("lost");
    expect(cuesMade(r.msgs)).toEqual([0]);
    // Watchdogs only on the graphics chip: its session's opening (60 s), then its lines (five times real time for their words, never under 15 s).
    expect(r.state.watchdogs).toEqual([GPU_OPEN_MS, 15_000, 18_000]);
    // main.ts starts the fresh worker on "lost", and ignores its warming.
    const main = read("web/src/main.ts");
    expect(main).toMatch(/if \(msg\.type === "lost"\) \{[\s\S]*?next\.postMessage\(\{ type: "render", cues, voices: cast\.voices, from: msg\.index, kept: msg\.kept \} satisfies ToWorker\);/);
    expect(gpuWatchdogMs(Array.from({ length: 300 }, () => "w").join(" "))).toBe(600_000);
  });

  for (const [hangAt, step] of [
    [1, "its warm-up"],
    [2, "the timed sentence"],
  ] as const) {
    it(`a graphics chip that never answers during the speed test (${step}) fails the trial: its model goes, and a fresh worker carries on`, async () => {
      const r = loopRig({ held: true, gpuRtf: 10, gpuHangAt: hangAt });
      await r.run();
      expect(r.msgs.some((m) => m.type === "testing")).toBe(true);
      expect(r.state.drops).toBe(1);
      // Nothing was made here, and no ready: the fresh worker starts from the first line.
      expect(cuesMade(r.msgs)).toEqual([]);
      const lost = r.msgs.at(-1) as Extract<FromWorker, { type: "lost" }>;
      expect(lost).toMatchObject({ type: "lost", index: 0 });
      expect(lost.kept.backend).toBe("wasm");
      expect(lost.kept.gpuRtf).toBe(0);
      // The open (60 s), then the warm-up and the sentence (15 s each) were bounded.
      expect(r.state.watchdogs.slice(0, 2)).toEqual([GPU_OPEN_MS, 15_000]);
    });
  }

  it("a kept graphics chip whose session never opens: its model goes, and a fresh worker carries on from the first line", async () => {
    const r = loopRig({ held: true, gpuRtf: 10, gpuOpenHangs: true, kept: keptGpu });
    await r.run();
    expect(r.state.watchdogs).toEqual([GPU_OPEN_MS]);
    expect(r.state.drops).toBe(1);
    expect(cuesMade(r.msgs)).toEqual([]);
    expect(r.msgs.at(-1)).toMatchObject({ type: "lost", index: 0 });
    // main.ts: a fresh worker before the first "ready" still brings the broadcast's own warming and ready.
    expect(read("web/src/main.ts")).toMatch(/if \(restarting && own\.ready && \(msg\.type === "loading" \|\| msg\.type === "ready"\)\)/);
  });

  it("the kept choice with its model gone (cleared site data): the processor makes the work", async () => {
    const r = loopRig({ held: false, gpuRtf: 10, kept: keptGpu });
    await r.run();
    expect(r.opened).toEqual(["wasm"]);
    const speed = r.msgs.find((m) => m.type === "speed") as Extract<FromWorker, { type: "speed" }>;
    expect(speed.choice.backend).toBe("wasm");
    expect(cuesMade(r.msgs)).toEqual([0, 1, 2]);
  });

  it("the model arriving mid-render (the listener's key) is tested between two lines, never before it arrives", async () => {
    const r = loopRig({ held: false, gpuRtf: 10 });
    const post = r.deps.post;
    r.deps.post = (m, t) => {
      post(m, t);
      if (m.type === "cue" && m.index === 0) {
        r.state.held = true;
        r.loop.onMessage({ type: "gpu" });
      }
    };
    await r.run();
    const kinds = r.msgs.map((m) => (m.type === "cue" ? `cue${m.index}` : m.type));
    expect(kinds.indexOf("testing")).toBeGreaterThan(kinds.indexOf("cue0"));
    expect(kinds.indexOf("testing")).toBeLessThan(kinds.indexOf("cue1"));
    expect(r.opened).toEqual(["webgpu"]);
  });
});
