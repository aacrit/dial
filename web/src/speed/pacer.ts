// The no-stall pacer for a work made on this device (T7): it holds playback
// until the plan (speed/plan.ts) says it will never catch the making, shows
// the countdown and the speed gauge, offers a choice past two minutes, and,
// should the device slow down anyway, holds cleanly at a line boundary
// ("Making the next line…") and plans again. It also keeps the making no
// further ahead of the listener than the memory cap allows (chapter-ahead).
//
// It drives the page only through its hooks (main.ts), so the page keeps
// one broadcast and one scheduler; playback is held by suspending the
// broadcast's own audio clock, which the scheduler's lines are timed on, so
// nothing is lost or re-timed while it waits.

import { WORDS_PER_MINUTE, countWords } from "../catalogue";
import type { Backend, SpeedChoice } from "./backend";
import { HOLD_LINE, TESTING_LINE, choiceQuestion, countdownLine, planSentence, valveCountdown } from "./copy";
import type { Gauge } from "./gauge";
import { aheadLimit, branchFor, leadWait, nextRate, paceScale, planRate, refillLines, type PlanLine } from "./plan";

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
  showAsk: (question: string, hasRecording: boolean) => void;
  hideAsk: () => void;
  /** The visual line under the status changed (progressLine). */
  repaint: () => void;
  /** The device may make lines up to this index (chapter-ahead within the memory cap). */
  allow: (upTo: number) => void;
  /** Pause pressed while playback waits: the key reads Resume while the listener holds it. */
  setPauseLabel: (paused: boolean) => void;
  /** Seconds, for measuring the making. */
  now: () => number;
}

type Mode = "loading" | "wait" | "hold" | "playing" | "off";

/** A wait under this is no wait: playback starts. */
const GO_S = 0.25;
/** The listener has caught the making when this little is left of what is made. */
const CAUGHT_S = 0.05;

export class Pacer {
  private mode: Mode = "loading";
  private measured = 0;
  private backend: Backend = "wasm";
  private choice: SpeedChoice | null = null;
  private lastCueAt = 0;
  private renderDone = false;
  /** The listener chose "Start anyway; it may pause": after a hold, only the next few seconds are made first. */
  private mayPause = false;
  /** The listener pressed Pause while playback waited. */
  private userPaused = false;
  private asked = false;
  private firstWait = 0;
  private allowed = Infinity;
  private text: string | null = null;
  private readonly estimates: number[];

  constructor(private readonly h: PacerHooks) {
    // Speech alone, estimated from the words (the pause is known from the pause table).
    this.estimates = h.cues.map((c) => (countWords(c.spoken) / WORDS_PER_MINUTE) * 60);
    void h.audio.suspend();
  }

  /** The line under the status while playback waits (the countdown), else null. */
  progressLine(): string | null {
    return this.text;
  }

  /** Playback is held (the countdown or a hold), so the page's own pause does not apply. */
  get waiting(): boolean {
    return this.mode === "loading" || this.mode === "wait" || this.mode === "hold";
  }

  testing(): void {
    this.h.gauge.show(this.backend);
    this.h.gauge.set(0);
    this.h.announce(TESTING_LINE);
  }

  speed(choice: SpeedChoice): void {
    this.choice = choice;
    this.backend = choice.backend;
    // A graphics chip the browser stopped reports the processor's speed, when it was timed; else the next lines measure it.
    if (choice.rtf > 0) this.measured = choice.rtf;
    this.h.gauge.show(this.backend);
    this.h.gauge.set(this.measured);
  }

  ready(): void {
    this.lastCueAt = this.h.now();
    this.mode = "wait";
    const wait = this.currentWait();
    this.firstWait = wait;
    if (this.choice && this.measured > 0) this.h.announce(planSentence(this.choice, this.measured, planRate(this.measured)));
    this.offerChoice(wait);
    this.evaluate();
  }

  /** A line was made: its speech measures the device live, and the plan follows. */
  cue(speechSeconds: number): void {
    const t = this.h.now();
    this.measured = nextRate(this.measured, speechSeconds, t - this.lastCueAt);
    this.lastCueAt = t;
    this.h.gauge.set(this.measured);
    this.pace();
    if (this.waiting && this.mode !== "loading") this.evaluate();
  }

  done(): void {
    this.renderDone = true;
    this.h.gauge.hide();
    if (this.waiting && this.mode !== "loading") this.go();
  }

  /** Every quarter second: the countdown, a hold when the listener catches the making, and the making's allowance. */
  tick(): void {
    if (this.mode === "off" || this.mode === "loading") return;
    this.pace();
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

  dispose(): void {
    this.mode = "off";
    this.text = null;
    this.h.gauge.hide();
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

  private offerChoice(wait: number): void {
    if (this.asked || this.mayPause || branchFor(wait) !== "choice") return;
    this.asked = true;
    this.h.showAsk(choiceQuestion(wait, this.h.hasRecording()), this.h.hasRecording());
  }

  private evaluate(): void {
    const wait = this.currentWait();
    if (wait < GO_S) return this.go();
    const counting = this.mode === "hold" || branchFor(this.firstWait) !== "short";
    this.text = counting && Number.isFinite(wait) ? countdownLine(wait) : null;
    const share = this.firstWait > 0 && Number.isFinite(wait) ? Math.max(0.08, Math.min(1, 1 - wait / this.firstWait)) : 0.08;
    this.h.setValve(share, counting && Number.isFinite(wait) ? valveCountdown(wait) : "Warming");
    this.h.repaint();
  }

  private hold(): void {
    this.mode = "hold";
    void this.h.audio.suspend();
    this.h.announce(HOLD_LINE);
    const wait = this.currentWait();
    this.firstWait = wait;
    this.offerChoice(wait);
    this.evaluate();
  }

  private go(): void {
    if (this.mode === "playing" || this.mode === "off") return;
    this.mode = "playing";
    this.text = null;
    this.h.hideAsk();
    this.h.setValve(1, "Voice ready");
    this.h.repaint();
    // The line under the status follows once the clock runs again.
    if (!this.userPaused) void this.h.audio.resume().then(() => this.h.repaint());
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
