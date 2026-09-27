// The Broadcast's scheduler: which made line goes on the audio clock when,
// where the listener is, what a seek does, and when the broadcast has ended.
// It holds no audio: the page gives it the audio clock and two callbacks
// (start a line's samples at a time, stop one), so tests drive it with a
// fake clock and fake lines.
//
// Work time runs from 0 at the first word; a line's length is its speech
// plus the silence after it (timeline.ts). Lines are put on the audio clock
// `lookahead` seconds ahead of the listener, from what is made. With the
// tab hidden the page raises the lookahead, so a locked phone keeps playing
// from what is already scheduled instead of waiting on a throttled timer.

import { lineAt } from "./timeline";

export interface SchedulerHooks<H> {
  /** The audio clock, in seconds. */
  now(): number;
  /** A made line's 16-bit samples: at once from memory, or later from the finished file. */
  samples(i: number): Int16Array | Promise<Int16Array>;
  /** Plays a line's samples from `offset` seconds in, starting at `at` on the audio clock; `ended` fires when it finishes by itself. */
  start(i: number, pcm: Int16Array, at: number, offset: number, ended: () => void): H;
  /** Stops a playing or scheduled line. Its `ended` must not fire after this. */
  stop(handle: H): void;
  /** The broadcast has ended: every line made and heard (or a seek past the end). Fires once. */
  complete(): void;
}

export interface Seek {
  /** The line playback moves to, and how far into it. */
  index: number;
  offset: number;
  /** The asked-for moment is past what is made (only while lines are still being made). */
  beyond: boolean;
  /** The seek went past the end of a finished work: the broadcast ended. */
  finished: boolean;
}

/** How soon a line may start on the audio clock after it is scheduled. */
const LEAD_S = 0.05;

export class Scheduler<H> {
  /** Per made line: its length (speech and silence), its speech alone, its start in work time. */
  readonly lengths: number[] = [];
  readonly speech: number[] = [];
  readonly at: number[] = [];
  /** When each scheduled line of the current schedule begins on the audio clock. */
  starts: number[] = [];
  made = 0;
  renderDone = false;
  lookahead: number;

  private nextIndex = 0;
  private nextAt: number;
  private nextOffset = 0;
  /** The place in work time before any line of this schedule has begun. */
  private from = 0;
  /** The line a seek landed on, shown as live until one begins. */
  private cued = -1;
  /** The first line of this schedule (a seek starts a schedule at its line). */
  private first = 0;
  /** How far into its first line the schedule starts (a seek's offset): the place never reads earlier than that. */
  private firstOffset = 0;
  /** The latest begun line of this schedule, from `first - 1`: moves forward only, so finding it is O(1) per frame. */
  private live = -1;
  private gen = 0;
  private feeding = false;
  private finished = false;
  private readonly playing = new Set<H>();

  constructor(
    private readonly total: number,
    private readonly hooks: SchedulerHooks<H>,
    lookahead = 4,
  ) {
    this.lookahead = lookahead;
    this.nextAt = hooks.now() + 0.2;
  }

  get done(): boolean {
    return this.finished;
  }

  /** Line i is made: `speech` seconds of voice, then `pause` of silence. Lines arrive in order. */
  add(i: number, speech: number, pause: number): void {
    this.speech[i] = speech;
    this.lengths[i] = speech + pause;
    this.at[i] = i === 0 ? 0 : this.at[i - 1]! + this.lengths[i - 1]!;
    this.made = i + 1;
    void this.feed();
  }

  /**
   * Lines 0 to n-1 are known by their lengths (from Dial's recording) but
   * have no samples on this device; playback starts at line n, which is made
   * next. Used when a recording this browser cannot decode is made on the
   * device from the line the listener had reached. Nothing is scheduled here.
   */
  seed(lines: readonly { speech: number; pause: number }[]): void {
    lines.forEach((l, i) => {
      this.speech[i] = l.speech;
      this.lengths[i] = l.speech + l.pause;
      this.at[i] = i === 0 ? 0 : this.at[i - 1]! + this.lengths[i - 1]!;
    });
    this.made = lines.length;
    this.nextIndex = lines.length;
    this.from = this.madeSeconds;
    this.cued = lines.length;
  }

  /** Every line is made. */
  renderFinished(): void {
    this.renderDone = true;
    void this.feed();
  }

  /** Seconds of the work made so far. */
  get madeSeconds(): number {
    return this.made ? this.at[this.made - 1]! + this.lengths[this.made - 1]! : 0;
  }

  /** The line on air: the latest begun line of this schedule, or the seek's line before one begins. */
  current(): number {
    const now = this.hooks.now();
    while (this.starts[this.live + 1] !== undefined && this.starts[this.live + 1]! <= now) this.live++;
    return this.live >= this.first ? this.live : this.cued;
  }

  /** The listener's place in work time. */
  position(): number {
    const now = this.hooks.now();
    this.current();
    const i = this.live;
    if (i < this.first) return this.from;
    // The first line's audio starts a moment after the seek, already `firstOffset` in: until then the place holds.
    const floor = i === this.first ? this.firstOffset : 0;
    return this.at[i]! + Math.max(floor, Math.min(this.lengths[i]!, now - this.starts[i]!));
  }

  /** Whether the live line is in its silence (the wave flattens; the meter falls to zero). */
  inSilence(): boolean {
    this.current();
    const i = this.live;
    return i >= this.first && this.hooks.now() - this.starts[i]! >= this.speech[i]!;
  }

  /** Puts made lines on the audio clock up to the lookahead. Safe to call at any time. */
  async feed(): Promise<void> {
    if (this.feeding || this.finished) return;
    this.feeding = true;
    const gen = this.gen;
    try {
      while (gen === this.gen && !this.finished && this.nextIndex < this.made && this.nextAt < this.hooks.now() + this.lookahead) {
        const i = this.nextIndex;
        const got = this.hooks.samples(i);
        const pcm = got instanceof Promise ? await got : got;
        if (gen !== this.gen || this.finished) break;
        this.schedule(i, pcm, this.nextOffset);
        this.nextOffset = 0;
      }
    } finally {
      this.feeding = false;
    }
    if (gen !== this.gen) void this.feed();
    else this.checkEnd();
  }

  private schedule(i: number, pcm: Int16Array, offset: number): void {
    // A line made late starts when it can: never before the one before it ends, so nothing overlaps.
    this.nextAt = Math.max(this.nextAt, this.hooks.now() + LEAD_S);
    const skip = Math.min(offset, this.lengths[i]!);
    if (pcm.length && skip < this.speech[i]! - 0.01) {
      const gen = this.gen;
      const handle: H = this.hooks.start(i, pcm, this.nextAt, skip, () => {
        if (gen !== this.gen || !this.playing.delete(handle)) return;
        this.checkEnd();
      });
      this.playing.add(handle);
    }
    this.starts[i] = this.nextAt - skip;
    this.nextAt += this.lengths[i]! - skip;
    this.nextIndex = i + 1;
  }

  /** Ended: every line made, all of them scheduled, and none still playing. */
  private checkEnd(): void {
    if (this.finished || !this.renderDone || this.playing.size > 0 || this.nextIndex < this.total) return;
    this.finished = true;
    this.hooks.complete();
  }

  /**
   * Moves playback to `t` in work time, within what is made.
   * - While lines are still being made, a moment past them goes no further
   *   than the last made line's start, and a forward seek never moves the
   *   listener backwards: past what is made, it stays where it is if that is
   *   already beyond the last made line's start.
   * - Once every line is made, a moment at or past the end ends the broadcast.
   */
  seek(t: number): Seek | null {
    if (this.made === 0 || this.finished) return null;
    const here = this.position();
    let target = Math.max(0, t);
    let beyond = false;
    if (target >= this.madeSeconds) {
      if (this.renderDone) {
        this.clear();
        this.nextIndex = this.total;
        this.checkEnd();
        return { index: this.total - 1, offset: this.lengths[this.total - 1] ?? 0, beyond: false, finished: true };
      }
      beyond = true;
      target = Math.max(here, this.at[this.made - 1]!);
    }
    const index = lineAt(this.at, target);
    const offset = target - this.at[index]!;
    this.clear();
    // The new schedule begins at `index`: the live pointer starts just before it, so it can walk forward.
    this.first = index;
    this.firstOffset = offset;
    this.live = index - 1;
    this.from = target;
    this.cued = index;
    this.nextIndex = index;
    this.nextOffset = offset;
    this.nextAt = this.hooks.now() + LEAD_S;
    void this.feed();
    return { index, offset, beyond, finished: false };
  }

  /** Drops the current schedule: every line on the clock is stopped without counting as ended. */
  private clear(): void {
    this.gen++;
    for (const h of this.playing) this.hooks.stop(h);
    this.playing.clear();
    this.starts = [];
    this.live = -1;
  }

  /**
   * The broadcast is over (stopped, finished, or tuned away): nothing more is
   * scheduled, and a line still being read back from the file is dropped, so
   * no source ever starts on a closed audio context.
   */
  dispose(): void {
    this.gen++;
    this.finished = true;
    this.playing.clear();
  }

  /** Lines playing or waiting on the audio clock (for tests and the hidden-tab check). */
  get scheduled(): number {
    return this.playing.size;
  }
}

