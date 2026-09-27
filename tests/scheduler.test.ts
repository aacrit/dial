// T3 fix round: the Broadcast's scheduler (web/src/player/scheduler.ts) with
// a fake audio clock and fake lines. It decides what goes on the clock, where
// the listener is, what a seek does and when the broadcast has ended.

import { describe, expect, it } from "vitest";
import { Scheduler, type SchedulerHooks } from "../web/src/player/scheduler";
import { nearestLineStart } from "../web/src/player/timeline";

/** Samples per second in the fake lines: a line of 1 s speech is 100 samples. */
const RATE = 100;
const SPEECH = 1;
const PAUSE = 0.5;

interface Fake {
  i: number;
  at: number;
  offset: number;
  end: number;
  ended: () => void;
  stopped: boolean;
  fired: boolean;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function rig(total: number, samples?: (i: number) => Int16Array | Promise<Int16Array>) {
  let now = 0;
  const started: Fake[] = [];
  let completes = 0;
  const hooks: SchedulerHooks<Fake> = {
    now: () => now,
    samples: samples ?? (() => new Int16Array(SPEECH * RATE)),
    start: (i, pcm, at, offset, ended) => {
      const h = { i, at, offset, end: at + pcm.length / RATE - offset, ended, stopped: false, fired: false };
      started.push(h);
      return h;
    },
    stop: (h) => {
      h.stopped = true;
    },
    complete: () => {
      completes++;
    },
  };
  const sched = new Scheduler(total, hooks, 4);
  /** Moves the clock, lets every line that has finished by then report its end, and feeds. */
  const advance = async (to: number) => {
    while (now < to) {
      now = Math.min(to, now + 0.25);
      for (const h of started) {
        if (!h.stopped && !h.fired && h.end <= now) {
          h.fired = true;
          h.ended();
        }
      }
      await sched.feed();
    }
    await flush();
  };
  const makeAll = async () => {
    for (let i = 0; i < total; i++) sched.add(i, SPEECH, PAUSE);
    sched.renderFinished();
    await flush();
  };
  return { sched, started, advance, makeAll, completes: () => completes, now: () => now };
}

describe("the scheduler: seeking and the end", () => {
  it("a seek, then natural completion, fires the end exactly once; the stopped lines never report", async () => {
    const r = rig(4);
    await r.makeAll();
    await r.advance(2);
    const pending = r.started.filter((h) => !h.fired);
    expect(pending.length).toBeGreaterThan(0);
    const before = r.started.length;
    r.sched.seek(0.5);
    await flush();
    // Every line of the old schedule still on the clock is stopped; the new one begins half a second into line 0.
    expect(pending.every((h) => h.stopped)).toBe(true);
    expect(r.started[before]).toMatchObject({ i: 0, offset: 0.5 });
    await r.advance(20);
    expect(r.completes()).toBe(1);
    expect(r.sched.done).toBe(true);
    // A late end from a stopped line cannot fire it again.
    for (const h of r.started) h.ended();
    expect(r.completes()).toBe(1);
  });

  it("a seek into the last line's silence ends the broadcast at once", async () => {
    const r = rig(3);
    await r.makeAll();
    const last = r.sched.at[2]!;
    const n = r.started.length;
    r.sched.seek(last + SPEECH + 0.2);
    await flush();
    // Nothing is left to hear: no line starts, and the end fires now.
    expect(r.started.length).toBe(n);
    expect(r.completes()).toBe(1);
  });

  it("a render slower than playback resumes with no overlap", async () => {
    const r = rig(3);
    r.sched.add(0, SPEECH, PAUSE);
    await flush();
    await r.advance(4);
    // Line 0 has been heard; line 1 arrives late.
    r.sched.add(1, SPEECH, PAUSE);
    await flush();
    const [a, b] = [r.started.find((h) => h.i === 0)!, r.started.find((h) => h.i === 1)!];
    expect(b.at).toBeGreaterThanOrEqual(a.at + SPEECH + PAUSE);
    expect(b.at).toBeGreaterThanOrEqual(r.now());
    r.sched.add(2, SPEECH, PAUSE);
    await flush();
    const c = r.started.find((h) => h.i === 2)!;
    expect(c.at).toBeCloseTo(b.at + SPEECH + PAUSE);
    expect(r.completes()).toBe(0);
    r.sched.renderFinished();
    await r.advance(20);
    expect(r.completes()).toBe(1);
  });

  it("a seek while a line is being read back from the file drops that line and plays the new place", async () => {
    let release: ((pcm: Int16Array) => void) | null = null;
    const r = rig(3, (i) =>
      i === 0
        ? new Int16Array(SPEECH * RATE)
        : new Promise<Int16Array>((resolve) => {
            release = resolve;
          }),
    );
    await r.makeAll();
    // Line 0 is on the clock; line 1's samples are still being read.
    expect(r.started.map((h) => h.i)).toEqual([0]);
    expect(release).not.toBeNull();
    const pending = release!;
    r.sched.seek(0.25);
    await flush();
    pending(new Int16Array(SPEECH * RATE));
    await flush();
    // The old schedule's line 1 never starts; the new one starts line 0 a quarter second in.
    const live = r.started.filter((h) => !h.stopped);
    expect(live.map((h) => [h.i, h.offset])).toEqual([[0, 0.25]]);
  });

  it("while lines are still being made, a forward seek past them never moves the listener backwards", async () => {
    const r = rig(6);
    for (let i = 0; i < 3; i++) r.sched.add(i, SPEECH, PAUSE);
    await flush();
    // Listen into line 2's speech (starts at 3.0 in work time).
    await r.advance(3.9);
    const here = r.sched.position();
    expect(here).toBeGreaterThan(r.sched.at[2]!);
    const s = r.sched.seek(1000)!;
    expect(s.beyond).toBe(true);
    expect(s.finished).toBe(false);
    expect(r.sched.position()).toBeGreaterThanOrEqual(here - 1e-9);
    // Earlier in the work, the same seek lands on the last made line's start.
    r.sched.seek(0);
    await flush();
    const t = r.sched.seek(1000)!;
    expect(t).toMatchObject({ index: 2, offset: 0, beyond: true });
  });

  it("once every line is made, a seek at or past the end ends the broadcast, with no 'not made' claim", async () => {
    const r = rig(3);
    await r.makeAll();
    const s = r.sched.seek(r.sched.madeSeconds + 5)!;
    expect(s).toMatchObject({ beyond: false, finished: true });
    expect(r.completes()).toBe(1);
    expect(r.started.every((h) => h.stopped)).toBe(true);
    expect(r.sched.seek(0)).toBeNull();
  });

  it("the live line is found by a pointer that only moves forward (not a scan per frame), and the seek's line shows before it begins", async () => {
    const r = rig(4);
    await r.makeAll();
    expect(r.sched.current()).toBe(-1);
    await r.advance(0.3);
    expect(r.sched.current()).toBe(0);
    await r.advance(1.9);
    expect(r.sched.current()).toBe(1);
    r.sched.seek(4.6);
    // Before the new schedule's first line begins on the clock, the seek's line stands in.
    expect(r.sched.current()).toBe(3);
    expect(r.sched.position()).toBeCloseTo(4.6);
  });

  it("after a seek to a later line, the live line and the place keep moving (the pointer starts at the seek's line)", async () => {
    const r = rig(8);
    await r.makeAll();
    await r.advance(0.5);
    // Line 3 starts at 4.5 in work time.
    r.sched.seek(r.sched.at[3]!);
    await flush();
    const t0 = r.now();
    await r.advance(t0 + 0.3);
    expect(r.sched.current()).toBe(3);
    const p1 = r.sched.position();
    // Past the start of line 4 (1.5 s later).
    await r.advance(t0 + 1.9);
    expect(r.sched.current()).toBe(4);
    const p2 = r.sched.position();
    expect(p2).toBeGreaterThan(p1 + 1);
    expect(p2).toBeGreaterThan(r.sched.at[4]!);
    expect(r.sched.inSilence()).toBe(false);
  });

  it("after a seek and 16 s of play mid-render, a seek past what is made never lands behind the true place", async () => {
    const r = rig(40);
    for (let i = 0; i < 20; i++) r.sched.add(i, SPEECH, PAUSE);
    await flush();
    r.sched.seek(r.sched.at[2]!);
    await flush();
    const t0 = r.now();
    await r.advance(t0 + 16);
    const truth = r.sched.at[2]! + 16 - 0.05;
    const here = r.sched.position();
    expect(here).toBeGreaterThan(truth - 0.3);
    const s = r.sched.seek(1000)!;
    expect(s.beyond).toBe(true);
    // The last made line (19) starts at 28.5, ahead of the listener: the seek goes there, never backwards.
    expect(r.sched.at[s.index]! + s.offset).toBeGreaterThanOrEqual(here);
    // Played on to past the last made line's start, the same seek stays put.
    await r.advance(r.now() + 3);
    const later = r.sched.position();
    const t = r.sched.seek(1000)!;
    expect(r.sched.at[t.index]! + t.offset).toBeGreaterThanOrEqual(later - 1e-9);
  });

  it("dispose drops a line still being read back, so nothing starts after the broadcast is over", async () => {
    let release: ((pcm: Int16Array) => void) | null = null;
    const r = rig(3, (i) =>
      i === 0
        ? new Int16Array(SPEECH * RATE)
        : new Promise<Int16Array>((resolve) => {
            release = resolve;
          }),
    );
    await r.makeAll();
    expect(r.started.map((h) => h.i)).toEqual([0]);
    r.sched.dispose();
    release!(new Int16Array(SPEECH * RATE));
    await flush();
    await r.sched.feed();
    expect(r.started.map((h) => h.i)).toEqual([0]);
    expect(r.sched.seek(0)).toBeNull();
    expect(r.completes()).toBe(0);
  });

  it("the silence after a line is known from the clock", async () => {
    const r = rig(2);
    await r.makeAll();
    await r.advance(0.75);
    expect(r.sched.inSilence()).toBe(false);
    await r.advance(1.5);
    expect(r.sched.inSilence()).toBe(true);
  });

  it("with the tab hidden, a longer lookahead puts every made line on the clock at once", async () => {
    const r = rig(40);
    await r.makeAll();
    const seen = r.started.length;
    expect(seen).toBeLessThan(10);
    r.sched.lookahead = 120;
    await r.sched.feed();
    await flush();
    expect(r.started.length).toBe(40);
  });
});

describe("a released drag lands on the nearest line start", () => {
  it("snaps to the nearest made line's start, and leaves a place past what is made to the seek", () => {
    const starts = [0, 1.5, 3, 4.5];
    expect(nearestLineStart(starts, 6, 1.2)).toBe(1.5);
    expect(nearestLineStart(starts, 6, 0.7)).toBe(0);
    expect(nearestLineStart(starts, 6, 4.9)).toBe(4.5);
    expect(nearestLineStart(starts, 6, 9)).toBe(9);
    expect(nearestLineStart([], 0, 2)).toBe(2);
  });
});
