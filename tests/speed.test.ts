// T7: the fastest engine, the speed gauge and the no-stall plan. The
// planner's maths, the engine choice and its cache on this device, the
// gauge's figures, the choice past two minutes, and a hold at a line
// boundary, each held without a browser (fake clock, fake scheduler).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { entryFor, gpuOffer, keptChoice, measuredEntry, parseEntry, pickBackend, shapeOf, soundsRight, type SpeedChoice, type SpeedEntry } from "../web/src/speed/backend";
import { HOLD_LINE, MEASURING_LINE, PLAY_RECORDING_NOW, START_ANYWAY, askLine, choiceQuestion, countdownClock, countdownLine, gpuButton, gpuLoadingLine, gpuOfferLine, planSentence, valveCountdown } from "../web/src/speed/copy";
import { GAUGE_MAX, engineLabel, engineWords, gaugeName, gaugeReadout, needleAngle, type Gauge } from "../web/src/speed/gauge";
import { Pacer, type AskOptions, type PacerHooks } from "../web/src/speed/pacer";
import { AHEAD_CAP_S, CHOICE_OVER_S, MIN_LEAD_S, PLANNING_MARGIN, aheadLimit, branchFor, leadWait, nextRate, paceScale, planRate, refillLines, type PlanLine } from "../web/src/speed/plan";
import { SPEED_KEY, keepSpeed, readSpeed } from "../web/src/speed/store";

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
    expect(countdownLine(42)).toBe("Starting in 0:42 so it never pauses.");
    expect(valveCountdown(303)).toBe("Starting in 5:03");
  });

  it("says the measured speed, the engine and the planned speed, and where each figure came from", () => {
    const now: SpeedChoice = { backend: "webgpu", rtf: 7.5, trials: [{ backend: "wasm", rtf: 1.1, ok: true }, { backend: "webgpu", rtf: 7.5, ok: true }], cached: false };
    expect(planSentence(now, 7.5, planRate(7.5))).toBe("This device makes speech at 7.5× real time on this device's graphics chip (1.1× on its processor), measured just now. Dial plans on 6.0× to be safe.");
    expect(planSentence({ backend: "wasm", rtf: 0, trials: [], cached: false }, 1.07, planRate(1.07))).toBe("This device makes speech at 1.1× real time on this device's processor, measured from its first line. Dial plans on 0.86× to be safe.");
    expect(planSentence({ backend: "wasm", rtf: 1, trials: [], cached: true }, 1, 0.8)).toContain("as measured on an earlier listen");
  });

  it("the choice past two minutes and the graphics chip's offer state the wait and the size, and no em dash anywhere", () => {
    expect(choiceQuestion(21 * 60 + 53, true)).toBe("To play without a pause, this device would make the first 21:53 before starting. Dial's own recording can play now instead.");
    expect(choiceQuestion(150, false)).toBe("To play without a pause, this device would make the first 2:30 before starting. You can wait, or start now and let it pause when it needs to.");
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
  const r: Rig = { clock, audio, sched, said: [], asks: [], hidden: 0, gauge: { shown: [], values: [] }, pacer: null! };
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
    askGpu: () => undefined,
    keep: () => undefined,
    setPauseLabel: () => undefined,
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
    expect(r.asks[0]!.question).toMatch(/^To play without a pause, this device would make the first \d+:\d\d before starting\. Dial's own recording can play now instead\.$/);
    expect(r.pacer.progressLine()).toMatch(/^Starting in \d+:\d\d so it never pauses\.$/);
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
    // It resumes at the next line boundary once the plan holds again.
    make(r, 11.6, 2.9);
    make(r, 11.6, 2.9);
    expect(r.pacer.waiting).toBe(false);
    expect(r.audio.state).toBe("running");
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

  it("the worker times each line itself and waits for the page's allowance (chapter-ahead)", () => {
    expect(worker).toMatch(/while \(i > allowed\) await new Promise<void>/);
    expect(worker).toMatch(/const ms = performance\.now\(\) - t0;/);
    expect(main).toMatch(/own\.pacer\?\.cue\(speech, msg\.ms \/ 1000\);/);
  });

  it("the gauge shows only while this device makes the work; Dial's recording never builds a pacer", () => {
    expect(main).toMatch(/if \(worker\) \{\s*const mine = \(\) => session === own && own\.live;\s*own\.pacer = new Pacer\(/);
    expect(main).toMatch(/const worker = rec \? null : new Worker\(/);
    expect(read("web/src/speed/pacer.ts")).toMatch(/done\(\): void \{[\s\S]*?this\.h\.gauge\.hide\(\);/);
    expect(read("web/src/speed/gauge.ts")).toMatch(/if \(motion\.reduce \|\| slot\.hidden\) \{\s*spring\.snap\(\);/);
  });
});
