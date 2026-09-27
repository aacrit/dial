// The radio's moving parts on the page: the needle in the dial window, the
// Tune and Volume knobs, the preset keys, the magic eye and the valve. The
// physics is pure (spring.ts, needle.ts); this file wires it to pointers,
// keys and one animation loop.
//
// Provenance (sadhana at a121809, read-only; nothing copied into it):
// - The loop is tweaked from frontend/app/components/VoiceWave.tsx: rAF with
//   the real dt clamped at 0.1 s, skipped while document.hidden, and one
//   static final frame under reduced motion. Changed: it draws SVG
//   attributes from token colours (no canvas rgba literals) and sleeps when
//   every spring is at rest, instead of running forever. The living wave,
//   its envelope and its live analyser are in wave.ts (a canvas loop of
//   their own), which reads alignment() from this handle each frame.
// - The tuning eye's alignment is tweaked from TanpuraViz.tsx (see
//   needle.ts), and so is its props-as-refs pattern: callers change state
//   through the returned handle, and the loop reads it without restarting.
// - The valve standing in for a spinner is tweaked from BrandLoader.tsx (a
//   brand moment in place of a spinner, resolved by a spring); framer-motion,
//   the overlay and the tagline are left behind.
// Reduced motion (reduced-motion.ts, lifted from useReducedMotion.ts) makes
// every spring snap to its target.

import type { Work } from "../catalogue";
import { presetKeysHtml, scaleSvg } from "../render";
import { alignment, angleAt, clampAngle, eyePath, eyeWedge, landing, nearestStation, tickStep } from "./needle";
import { motion } from "./reduced-motion";
import { PRESETS, Spring, parseSpring, type SpringParams } from "./spring";

export type TuneCause = "load" | "user";

export interface RadioOptions {
  /** The needle has been sent to a station (it may still be swinging there). */
  onTune(index: number, cause: TuneCause): void;
  /** Volume, 0 to 1. */
  onVolume(value: number): void;
  /** The station the needle rests on at mount (a /play/<work> address opens tuned to its work). */
  start?: number;
}

export interface Radio {
  tune(index: number, cause: TuneCause): void;
  tuned(): number;
  /** 0 = cold (the eye dim), 1 = warm. */
  setPower(value: number): void;
  /** The valve's glow, 0 to 1: the share of the voice that has arrived. */
  setValve(value: number): void;
  /** 1 when the voice is ready (or nothing is warming): the eye closes on station only then. */
  setReady(value: number): void;
  /** How close the needle is to a station right now, 0 to 1 (the living wave reads it each frame). */
  alignment(): number;
}

/** Captures the pointer for a drag; false when the browser refuses (the pointer is already gone). */
export function capture(el: Element, e: PointerEvent): boolean {
  try {
    el.setPointerCapture(e.pointerId);
    return true;
  } catch {
    return false;
  }
}

const SVG_W = 400;
const SVG_H = 250;

function tokenPresets(): Record<"swing" | "drop" | "follow" | "warm" | "vu", SpringParams> {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: SpringParams) => parseSpring(css.getPropertyValue(name), fallback);
  return {
    swing: read("--spring-needle-swing", PRESETS.swing),
    drop: read("--spring-needle-drop", PRESETS.drop),
    follow: read("--spring-follow", PRESETS.follow),
    warm: read("--spring-valve-warm", PRESETS.warm),
    vu: read("--spring-vu", PRESETS.vu),
  };
}

export function mountRadio(root: HTMLElement, works: readonly Work[], options: RadioOptions): Radio {
  const P = tokenPresets();
  const angles = works.map((w) => w.angle);
  const win = root.querySelector<HTMLElement>("[data-dialwin]")!;
  const scale = win.querySelector<SVGGElement>(".dw-scale")!;
  const needleG = win.querySelector<SVGGElement>(".dw-needle")!;
  const readout = win.querySelector<SVGTextElement>(".dw-am")!;
  const keys = root.querySelector<HTMLElement>("[data-presets]")!;
  const eyeFan = root.querySelector<SVGPathElement>("[data-eye]");
  const valveFil = root.querySelector<SVGPathElement>(".v-fil");
  const valveGlow = root.querySelector<SVGCircleElement>(".v-glow");

  let tuned = 0;
  const needle = new Spring(P.swing, angles[0]);
  const eye = new Spring(P.vu, eyeWedge(1));
  const power = new Spring(P.warm, 0);
  const valve = new Spring(P.warm, 0);
  // The eye closes on a station once the voice is ready: while it warms, the eye stays part open.
  let ready = 1;

  // ---- scale and keys ------------------------------------------------------
  const drawScale = () => {
    scale.innerHTML = scaleSvg(works, tickStep(win.clientWidth || SVG_W), tuned);
  };
  keys.innerHTML = presetKeysHtml(works, tuned);

  // ---- the loop: runs while anything moves, then sleeps ---------------------
  let frame = 0;
  let last = 0;
  const knobs: { spring: Spring; rot: HTMLElement }[] = [];
  const springs = () => [needle, eye, power, valve, ...knobs.map((k) => k.spring)];

  const paint = (ms: number) => {
    needleG.setAttribute("transform", `rotate(${needle.x.toFixed(2)} 200 236)`);
    if (eyeFan) {
      eyeFan.setAttribute("d", eyePath(eye.x));
      eyeFan.style.opacity = String(0.25 + 0.75 * Math.max(0, Math.min(1, power.x)));
    }
    if (valveFil && valveGlow) {
      const g = Math.max(0, Math.min(1, valve.x));
      // Below 35% the filament flickers while it warms (design/spec.md 0.1); never under reduced motion.
      const flicker = g > 0 && g < 0.35 && !motion.reduce ? 0.6 + 0.4 * Math.sin(ms / 37) * Math.sin(ms / 91) : 1;
      valveFil.style.opacity = String(0.15 + 0.85 * g * flicker);
      valveGlow.style.opacity = String(g * flicker);
    }
    for (const k of knobs) k.rot.style.transform = `rotate(${k.spring.x.toFixed(2)}deg)`;
  };

  const tick = (ms: number) => {
    frame = 0;
    const dt = last ? Math.min((ms - last) / 1000, 0.1) : 1 / 60;
    last = ms;
    if (document.hidden) {
      // Nothing to see: step once when the tab comes back.
      last = 0;
      frame = requestAnimationFrame(tick);
      return;
    }
    needle.step(dt, motion.reduce);
    // Reduced motion draws the eye closed (design/spec.md 1.4): it neither opens off station nor while the voice warms.
    eye.to(eyeWedge(motion.reduce ? 1 : alignment(angles, needle.x) * ready)).step(dt, motion.reduce);
    power.step(dt, motion.reduce);
    valve.step(dt, motion.reduce);
    for (const k of knobs) k.spring.step(dt, motion.reduce);
    paint(ms);
    const warmFlicker = valve.target > 0 && valve.target < 0.35 && !motion.reduce;
    if (dragging || warmFlicker || !springs().every((s) => s.resting)) frame = requestAnimationFrame(tick);
    else last = 0;
  };
  const wake = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };

  // ---- tuning ---------------------------------------------------------------
  const tune = (index: number, cause: TuneCause, preset: SpringParams = P.swing) => {
    tuned = Math.max(0, Math.min(works.length - 1, index));
    const w = works[tuned]!;
    needle.use(preset).to(w.angle);
    readout.textContent = `514 · ${w.station}`; // the readout follows the station
    scale.querySelectorAll<SVGTextElement>(".lb").forEach((t) => t.classList.toggle("on", Number(t.dataset.i) === tuned));
    keys.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.preset) === tuned)));
    win.setAttribute("aria-valuenow", String(tuned + 1));
    win.setAttribute("aria-valuetext", `514, No. ${w.station}, ${w.title}`);
    const tuneKnob = root.querySelector('[data-knob="tune"]');
    tuneKnob?.setAttribute("aria-valuenow", String(tuned + 1));
    tuneKnob?.setAttribute("aria-valuetext", w.title);
    options.onTune(tuned, cause);
    wake();
  };

  keys.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-preset]");
    if (b) tune(Number(b.dataset.preset), "user");
  });

  // Drag the needle: it follows the finger on `follow`; on release it keeps
  // its speed, the landing is projected ahead, and it snaps to a station.
  let dragging = false;
  const pointerAngle = (e: PointerEvent) => {
    const r = win.getBoundingClientRect();
    return angleAt(((e.clientX - r.left) / r.width) * SVG_W, ((e.clientY - r.top) / r.height) * SVG_H);
  };
  win.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // Drag only once the capture holds: a capture that throws leaves no half-started drag.
    if (!capture(win, e)) return;
    dragging = true;
    needle.use(P.follow).to(pointerAngle(e));
    wake();
  });
  win.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    needle.to(pointerAngle(e));
    wake();
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    tune(landing(angles, needle.x, needle.v), "user");
  };
  win.addEventListener("pointerup", release);
  win.addEventListener("pointercancel", release);
  win.addEventListener("lostpointercapture", release);

  const step = (e: KeyboardEvent): number | null => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") return Math.min(works.length - 1, tuned + 1);
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") return Math.max(0, tuned - 1);
    if (e.key === "Home") return 0;
    if (e.key === "End") return works.length - 1;
    return null;
  };
  win.addEventListener("keydown", (e) => {
    const next = step(e);
    if (next === null) return;
    e.preventDefault();
    if (next !== tuned) tune(next, "user");
  });

  // ---- knobs: drag around the centre, or the arrow keys ---------------------
  for (const knob of root.querySelectorAll<HTMLElement>("[data-knob]")) {
    const kind = knob.dataset.knob as "vol" | "tune";
    const face = knob.querySelector<HTMLElement>(".kn-dial")!;
    const rot = knob.querySelector<HTMLElement>(".kn-rot")!;
    let volume = Number(knob.getAttribute("aria-valuenow") ?? 70) / 100;
    const spring = new Spring(P.follow, kind === "vol" ? -135 + volume * 270 : 0);
    knobs.push({ spring, rot });
    let lastAngle: number | null = null;
    const at = (e: PointerEvent) => {
      const r = face.getBoundingClientRect();
      return (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI;
    };
    const setVolume = (v: number) => {
      volume = Math.max(0, Math.min(1, v));
      spring.to(-135 + volume * 270);
      knob.setAttribute("aria-valuenow", String(Math.round(volume * 100)));
      knob.setAttribute("aria-valuetext", `${Math.round(volume * 100)} percent`);
      options.onVolume(volume);
      wake();
    };
    const turn = (deg: number) => {
      if (kind === "vol") return setVolume(volume + deg / 270);
      // Turning Tune moves the needle; release snaps to the nearest station.
      spring.to(spring.target + deg);
      needle.use(P.follow).to(clampAngle(needle.target + deg * 0.45));
      wake();
    };
    knob.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !capture(knob, e)) return;
      lastAngle = at(e);
    });
    knob.addEventListener("pointermove", (e) => {
      if (lastAngle === null) return;
      const a = at(e);
      let d = a - lastAngle;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      lastAngle = a;
      turn(d);
    });
    const up = () => {
      if (lastAngle === null) return;
      lastAngle = null;
      if (kind === "tune") tune(nearestStation(angles, needle.target), "user");
    };
    knob.addEventListener("pointerup", up);
    knob.addEventListener("pointercancel", up);
    knob.addEventListener("lostpointercapture", up);
    knob.addEventListener("keydown", (e) => {
      if (kind === "vol") {
        const d = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05, PageUp: 0.2, PageDown: -0.2 }[e.key];
        if (d !== undefined) {
          e.preventDefault();
          setVolume(volume + d);
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          setVolume(e.key === "Home" ? 0 : 1);
        }
        return;
      }
      const next = step(e);
      if (next === null) return;
      e.preventDefault();
      spring.to(spring.target + (next > tuned ? 30 : next < tuned ? -30 : 0));
      if (next !== tuned) tune(next, "user");
      else wake();
    });
  }

  drawScale();
  addEventListener("resize", drawScale);
  tune(Math.max(0, Math.min(works.length - 1, options.start ?? 0)), "load", P.drop);
  needle.snap();
  eye.to(eyeWedge(1)).snap();
  paint(0);

  return {
    tune: (i, cause) => tune(i, cause),
    tuned: () => tuned,
    setPower: (v) => {
      power.to(v);
      wake();
    },
    setValve: (v) => {
      valve.to(Math.max(0, Math.min(1, v)));
      wake();
    },
    setReady: (v) => {
      ready = Math.max(0, Math.min(1, v));
      wake();
    },
    alignment: () => alignment(angles, needle.x),
  };
}
