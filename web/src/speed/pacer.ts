// The no-stall pacer for a work made on this device (T7): it holds playback
// until the plan (speed/plan.ts), at four fifths of the measured speed,
// forecasts it will not catch the making (a forecast, not a promise: CoS
// decision O words it "should not pause"), shows
// the countdown and the speed gauge, offers a choice past two minutes (and
// the graphics chip, where there is one to test), and, should the device
// slow down anyway, holds cleanly at a line boundary ("Making the next
// line…") and plans again. It also keeps the making no further ahead of the
// listener than the memory cap allows (chapter-ahead), and keeps this
// device's measured speed on this device (speed/store.ts), never sent.
//
// It drives the page only through its hooks (main.ts), so the page keeps
// one broadcast and one scheduler; playback is held by suspending the
// broadcast's own audio clock, which the scheduler's lines are timed on, so
// nothing is lost or re-timed while it waits.

import { WORDS_PER_MINUTE, countWords } from "../catalogue";
import { measuredEntry, type Backend, type SpeedChoice, type SpeedEntry } from "./backend";
import { GPU_FAILED_LINE, GPU_LOST_LINE, HOLD_LINE, MEASURING_LINE, MEASURING_SHORT, SHORT_LEAD_LINE, TESTING_LINE, askLine, countdownLine, gpuLoadingLine, gpuNoRoomLine, gpuProgress, planSentence, valveCountdown, valveResuming } from "./copy";
import type { Gauge } from "./gauge";
import { MIN_LEAD_S, aheadLimit, branchFor, leadWait, nextRate, paceScale, planRate, refillLines, type PlanLine } from "./plan";

/** What the ask on the radio offers (index.html #speed-ask). */
export interface AskOptions {
  /** Play Dial's recording now (the default where there is one). */
  recording: boolean;
  /** Start anyway; it may pause. */
  anyway: boolean;
  /** Test the graphics chip: its model's size in bytes, or 0. */
  gpuBytes: number;
}

export interface PacerHooks {
  cues: readonly { spoken: string; pauseAfterMs: number }[];
  /** The broadcast's scheduler: what is made (real lengths) and where the listener is. */
  sched: { readonly made: number; readonly madeSeconds: number; readonly speech: readonly number[]; readonly lengths: readonly number[]; position(): number };
  /** The broadcast's audio clock: suspended while playback waits. */
  audio: { readonly state: string; suspend(): Promise<void>; resume(): Promise<void> };
  gauge: Gauge;
  /** Whether Dial's prepared recording of this work plays in this browser. */
  hasRecording: () => boolean;
  playRecording: () => void;
  announce: (line: string) => void;
  setValve: (share: number, label: string) => void;
  /** Opens the ask (a sheet over the radio) with its words and keys. */
  showAsk: (question: string, options: AskOptions) => void;
  hideAsk: () => void;
  /** The visual line under the status changed (progressLine). */
  repaint: () => void;
  /** The device may make lines up to this index (chapter-ahead within the memory cap). */
  allow: (upTo: number) => void;
  /** Downloads the graphics chip's model (the listener pressed its key); the page calls gpuLoading, gpuReady or gpuFailed. */
  askGpu: () => void;
  /** Tells the render worker the model is here: it tests it between two lines, a pause in the making. */
  sendGpu: () => void;
  /** Keeps this device's measured speed on this device (speed/store.ts). */
  keep: (entry: SpeedEntry) => void;
  /** Pause pressed while playback waits: the key reads Resume while the listener holds it. */
  setPauseLabel: (paused: boolean) => void;
  /** Seconds, for measuring the making. */
  now: () => number;
  /** Playback runs again after a hold: the page says it is on air again. */
  resumed: () => void;
}

type Mode = "loading" | "wait" | "hold" | "playing" | "off";

/** A wait under this is no wait: playback starts. */
const GO_S = 0.25;
/** The listener has caught the making when this little is left of what is made. */
const CAUGHT_S = 0.05;
/** The measured speed is kept after this many lines, and again when the work is made. */
const KEEP_EVERY = 10;
/** While playing, the graphics chip is tested (the making pauses for it, about 7 to 11 s here) only with this much made ahead of the listener. */
export const TEST_AHEAD_S = 30;

export class Pacer {
  private mode: Mode = "loading";
  private measured = 0;
  private backend: Backend = "wasm";
  private choice: SpeedChoice | null = null;
  private entry: SpeedEntry | null = null;
  private lastCueAt = 0;
  private lines_ = 0;
  private renderDone = false;
  /** The listener chose "Start anyway; it may pause": after a hold, only the next few seconds are made first. */
  private mayPause = false;
  /** The listener pressed Pause while playback waited. */
  private userPaused = false;
  private planSaid = false;
  /** The ask's state: the two-minute choice shown, and the graphics chip offered (bytes) or asked for. */
  private choiceShown = false;
  private gpuBytes = 0;
  private gpuAsked = false;
  /** The graphics chip was offered once this visit: not again on a later hold. */
  private gpuOffered = false;
  /** Its model is here, waiting for a safe moment to be tested. */
  private gpuPending = false;
  private gpuLine = "";
  private firstWait = 0;
  private allowed = Infinity;
  private text: string | null = null;
  private shortText: string | null = null;
  private readonly estimates: number[];

  constructor(private readonly h: PacerHooks) {
    // Speech alone, estimated from the words (the pause is known from the pause table).
    this.estimates = h.cues.map((c) => (countWords(c.spoken) / WORDS_PER_MINUTE) * 60);
    void h.audio.suspend();
  }

  /** The line under the status while playback waits (the countdown), else null. */
  progressLine(): string | null {
    // The graphics chip's voice arriving, beside the countdown, or alone once playing.
    // Beside the download, the countdown keeps only its time, so the line fits the radio's panel on a small screen.
    if (this.gpuLine) return this.text ? `${this.shortText ?? this.text} ${this.gpuLine}` : this.gpuLine;
    return this.text;
  }

  /** Playback is held (the countdown or a hold), so the page's own pause does not apply. */
  get waiting(): boolean {
    return this.mode === "loading" || this.mode === "wait" || this.mode === "hold";
  }

  /** The speed test is timing its sentence: the making pauses for it. */
  testing(): void {
    if (this.mode === "loading") this.h.setValve(1, "Testing");
    this.h.gauge.show(this.backend);
    this.h.announce(TESTING_LINE);
  }

  /** The engine in use (after loading, a test, or a graphics chip the browser stopped) and what to keep. */
  speed(choice: SpeedChoice, entry: SpeedEntry, gpuOffer: number): void {
    const switched = choice.backend !== this.backend;
    // The browser stopped the graphics chip (not a test's result): say so; the plan follows the processor's speed.
    if (switched && this.backend === "webgpu" && !choice.trials.length && this.mode !== "loading") this.h.announce(GPU_LOST_LINE);
    this.choice = choice;
    this.backend = choice.backend;
    this.entry = entry;
    if (entry.rtf > 0) this.h.keep(entry);
    // A new engine starts from its own measurement; the same engine keeps the live one.
    if (switched || (choice.rtf > 0 && !(this.measured > 0))) this.measured = choice.rtf;
    if (gpuOffer > 0 && !this.gpuAsked) this.gpuBytes = gpuOffer;
    // The test's own time is not the making's speed.
    if (this.mode !== "loading") this.lastCueAt = this.h.now();
    this.h.gauge.show(this.backend);
    this.h.gauge.set(this.measured);
    if (choice.trials.length && this.mode !== "loading") {
      // A test between lines (the listener asked for the graphics chip): say the result, and plan again.
      this.gpuBytes = 0;
      this.gpuLine = "";
      this.planSaid = false;
      this.sayPlan();
      this.choiceShown = false;
      this.h.hideAsk();
      this.h.repaint();
      if (this.waiting) {
        this.firstWait = this.currentWait();
        this.offer(this.firstWait);
        this.evaluate();
      }
    }
  }

  ready(): void {
    this.lastCueAt = this.h.now();
    this.mode = "wait";
    if (this.measured > 0) this.sayPlan();
    else this.h.announce(MEASURING_LINE);
    this.firstWait = this.currentWait();
    this.offer(this.firstWait);
    this.evaluate();
  }

  /** A line was made in `workSeconds` (timed by the worker): its speech measures the device live, and the plan follows. */
  cue(speechSeconds: number, workSeconds: number): void {
    const t = this.h.now();
    const first = !(this.measured > 0);
    this.measured = nextRate(this.measured, speechSeconds, workSeconds);
    this.lastCueAt = t;
    this.lines_++;
    this.h.gauge.set(this.measured);
    if (this.lines_ % KEEP_EVERY === 1) this.keepMeasured();
    this.pace();
    this.maybeSendGpu();
    if (!this.waiting || this.mode === "loading") return;
    if (first) {
      // The first line measured the device: now the plan has a speed.
      this.sayPlan();
      this.firstWait = this.currentWait();
      this.offer(this.firstWait);
    }
    this.evaluate();
  }

  done(): void {
    this.renderDone = true;
    this.keepMeasured();
    this.h.gauge.hide();
    if (this.waiting && this.mode !== "loading") this.go();
  }

  /** Every quarter second: the countdown, a hold when the listener catches the making, and the making's allowance. */
  tick(): void {
    if (this.mode === "off" || this.mode === "loading") return;
    this.pace();
    this.maybeSendGpu();
    if (this.mode === "wait" || this.mode === "hold") return this.evaluate();
    const s = this.h.sched;
    if (!this.renderDone && this.h.audio.state === "running" && s.made < this.h.cues.length && s.position() >= s.madeSeconds - CAUGHT_S) this.hold();
  }

  /** Pause pressed: while playback waits, it only decides whether playback starts by itself. Returns whether it was taken. */
  pausePressed(): boolean {
    if (!this.waiting) return false;
    this.userPaused = !this.userPaused;
    this.h.setPauseLabel(this.userPaused);
    return true;
  }

  /** "Start anyway; it may pause". */
  startAnyway(): void {
    this.mayPause = true;
    this.go();
  }

  /** "Play Dial's recording now". */
  playRecording(): void {
    this.h.playRecording();
  }

  /** "Test the graphics chip": its model downloads (its size was shown), then it is tested between two lines. */
  testGpu(): void {
    if (this.gpuAsked || !(this.gpuBytes > 0)) return;
    this.gpuAsked = true;
    this.h.hideAsk();
    this.h.askGpu();
    this.h.announce(gpuLoadingLine(0, this.gpuBytes));
    this.gpuLine = gpuProgress(0, this.gpuBytes);
    this.h.repaint();
  }

  gpuLoading(loaded: number, total: number): void {
    if (this.mode === "off" || !this.gpuLine) return;
    // The line under the status changes once per megabyte, not per chunk that arrives.
    const line = gpuProgress(loaded, total);
    if (line === this.gpuLine) return;
    this.gpuLine = line;
    this.h.repaint();
  }

  /** Its model is kept on this device: tested at the next safe moment. */
  gpuReady(): void {
    this.gpuPending = true;
    this.maybeSendGpu();
  }

  /** It could not be downloaded or kept; `noRoom`: there was no room for it, and the listener is told the fix. */
  gpuFailed(noRoom = false): void {
    const bytes = this.gpuBytes;
    this.gpuBytes = 0;
    this.gpuLine = "";
    if (this.mode === "off") return;
    this.h.announce(noRoom ? gpuNoRoomLine(bytes) : GPU_FAILED_LINE);
    this.h.repaint();
  }

  /** A fresh render worker carries on (the graphics chip stopped): it hears the current allowance at the next tick. */
  restarted(): void {
    this.allowed = Infinity;
  }

  dispose(): void {
    this.mode = "off";
    this.text = null;
    this.keepMeasured();
    this.h.gauge.hide();
  }

  private sayPlan(): void {
    if (this.planSaid || !this.choice || !(this.measured > 0)) return;
    this.planSaid = true;
    this.h.announce(planSentence(this.choice, this.measured, planRate(this.measured)));
  }

  private keepMeasured(): void {
    const e = measuredEntry(this.entry, this.backend, this.measured);
    if (e) this.h.keep(e);
  }

  /** Every line's speech and silence: real once made, else estimated at this voice's measured pace. */
  private lines(): PlanLine[] {
    const s = this.h.sched;
    const real: number[] = [];
    for (let i = 0; i < s.made; i++) real.push(s.speech[i] ?? 0);
    const scale = paceScale(real, this.estimates.slice(0, s.made));
    return this.h.cues.map((c, i) => (i < s.made ? { speech: s.speech[i] ?? 0, pause: (s.lengths[i] ?? 0) - (s.speech[i] ?? 0) } : { speech: this.estimates[i]! * scale, pause: c.pauseAfterMs / 1000 }));
  }

  private currentWait(): number {
    if (this.renderDone) return 0;
    const s = this.h.sched;
    const pos = s.position();
    const all = this.lines();
    const lines = this.mayPause ? refillLines(all, pos) : all;
    return leadWait(lines, s.made, pos, planRate(this.measured), this.h.now() - this.lastCueAt);
  }

  /** Past two minutes, the choice; with a real countdown, the graphics chip where there is one to test, once a visit. */
  private offer(wait: number): void {
    if (!Number.isFinite(wait)) return;
    const branch = branchFor(wait);
    const choice = branch === "choice" && !this.mayPause && !this.choiceShown;
    const gpu = branch !== "short" && this.gpuBytes > 0 && !this.gpuAsked && !this.gpuOffered;
    if (!choice && !gpu) return;
    if (choice) this.choiceShown = true;
    if (gpu) this.gpuOffered = true;
    const gpuBytes = gpu ? this.gpuBytes : 0;
    const recording = this.choiceShown && this.h.hasRecording();
    this.h.showAsk(askLine({ wait, choice: this.choiceShown, hasRecording: this.h.hasRecording(), gpuBytes }), { recording, anyway: this.choiceShown, gpuBytes });
  }

  /** The graphics chip's model is tested only while playback waits, or with TEST_AHEAD_S made ahead, so the pause in the making is never heard. */
  private maybeSendGpu(): void {
    if (!this.gpuPending || this.mode === "off" || this.mode === "loading") return;
    const s = this.h.sched;
    if (!this.waiting && s.madeSeconds - s.position() < TEST_AHEAD_S) return;
    this.gpuPending = false;
    this.h.sendGpu();
  }

  /** What is really made ahead of the listener covers the first MIN_LEAD_S (or the rest of the work): never started on an estimate alone. */
  private leadMade(): boolean {
    if (this.renderDone) return true;
    const s = this.h.sched;
    const pos = s.position();
    const rest = this.lines().reduce((sum, l) => sum + l.speech + l.pause, 0) - pos;
    return s.madeSeconds - pos >= Math.min(MIN_LEAD_S, rest - CAUGHT_S);
  }

  private evaluate(): void {
    const wait = this.currentWait();
    const made = this.leadMade();
    if (wait < GO_S && made) return this.go();
    const known = Number.isFinite(wait);
    // The plan says go but the lines are not here yet (the device is running late): no figure, just what it is doing.
    const late = known && wait < GO_S;
    const counting = known && !late && (this.mode === "hold" || branchFor(this.firstWait) !== "short");
    // A hold says only what it is doing (CoS decision O); the valve counts it down.
    const holding = this.mode === "hold";
    this.text = holding ? HOLD_LINE : counting ? countdownLine(wait, this.mayPause) : known ? SHORT_LEAD_LINE : MEASURING_SHORT;
    this.shortText = !holding && counting ? countdownLine(wait, true) : null;
    const share = this.firstWait > 0 && known && Number.isFinite(this.firstWait) ? Math.max(0.08, Math.min(1, 1 - wait / this.firstWait)) : 0.08;
    this.h.setValve(share, counting ? (holding ? valveResuming(wait) : valveCountdown(wait)) : holding ? "Making" : known ? "Warming" : "Measuring");
    this.h.repaint();
  }

  private hold(): void {
    this.mode = "hold";
    void this.h.audio.suspend();
    this.h.announce(HOLD_LINE);
    this.firstWait = this.currentWait();
    this.choiceShown = false;
    this.offer(this.firstWait);
    this.evaluate();
  }

  private go(): void {
    if (this.mode === "playing" || this.mode === "off") return;
    const fromHold = this.mode === "hold";
    this.mode = "playing";
    if (fromHold) this.h.resumed();
    this.text = null;
    this.h.hideAsk();
    this.h.setValve(1, "Voice ready");
    // Held by the listener: the line says paused now. Else it follows once the clock runs again (never a flash of "Paused").
    if (this.userPaused) this.h.repaint();
    else void this.h.audio.resume().then(() => this.h.repaint());
  }

  /** Chapter-ahead: the making stays within the memory cap of the listener. */
  private pace(): void {
    const upTo = aheadLimit(this.lines(), this.h.sched.position());
    if (upTo === this.allowed) return;
    // The device was waiting for this allowance: that wait is not its speed.
    if (this.h.sched.made > this.allowed) this.lastCueAt = this.h.now();
    this.allowed = upTo;
    this.h.allow(upTo);
  }
}
