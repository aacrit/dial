// The living wave in the dial window, and the Voice and Music meters it
// shares a clock with. Both read one AnalyserNode on the broadcast's own
// AudioContext (main.ts): the samples are read here, in this tab, and go
// nowhere else.
//
// Provenance (sadhana at a121809, read-only; nothing copied into it;
// design/spec.md 0.6):
// - Tweaked from frontend/app/components/VoiceWave.tsx. Lifted: the canvas
//   loop (rAF with the real dt clamped at 0.1 s, skipped while
//   document.hidden, one static draw under reduced motion), the sin(pi x)
//   edge envelope, the 3 px step, and ambient drift mixed with the live
//   analyser's time-domain samples. Changed: five coloured lines become one
//   amber carrier and two ghost lines; colours are read from the tokens
//   (design/tokens.css), never rgba literals; the height is the voice's
//   loudness; the canvas's pixel ratio is capped at 2; the loop allocates
//   nothing per frame (one sample buffer, made when an analyser arrives).
//   Left behind: the swara markers and the Hz scale.
// - Tweaked from frontend/app/lib/VoiceWaveContext.tsx. Lifted: one shared
//   analyser registered when playback starts, with ambient drift when none
//   is registered. Changed: a plain handle (setAnalyser) instead of a React
//   context; saHz becomes the live line's register and silence.
// - Tweaked from frontend/app/components/TanpuraViz.tsx: the ghost lines
//   converge as the needle nears a station and drift apart off station, and
//   the props-as-refs pattern (the loop reads `air` without restarting).
//   Left behind: the fixed 0.016 s step, the string colours, Sa/Pa ratios.
// - usePerfTier.ts (perf-tier.ts) thins the drawing only.

import { loudnessToHeight, registerToken, rms, toDbfs, inBand, type Register } from "../player/levels";
import { Spring, type SpringParams } from "./spring";
import { motion } from "./reduced-motion";
import type { PerfTier } from "./perf-tier";
import { waveDetail } from "./perf-tier";

/** The dial window's coordinate space (the SVG's viewBox), and where the wave runs in it. */
const VIEW_W = 400;
const VIEW_H = 250;
const X0 = 40;
const X1 = 360;
const Y0 = 198;
/** The carrier's height at rest (design/spec.md 0.1: a faint 0.16 carrier). */
export const REST_CARRIER = 0.16;
/** At rest (nothing playing) the ambient drift is drawn about 20 times a second, not at the display's rate. */
export const REST_FRAME_MS = 50;
/** The peak hold falls back at this share of the meter a second. */
export const PEAK_FALL_PER_S = 0.35;

/** The Voice meter's spoken value: its height on the 0 to -40 dBFS scale, as a share, or "Silent". */
export function meterText(pct: number): string {
  return pct <= 0 ? "Silent" : `${pct} percent`;
}

/** The peak hold, pure: it jumps up to a louder level at once and falls back slowly. */
export function peakHold(peak: number, level: number, dt: number): number {
  return Math.max(level, peak - PEAK_FALL_PER_S * dt);
}

/**
 * One point of a wave line, pure. `u` is 0 to 1 across the window, `t` the
 * wave's clock, `level` the voice's loudness (0 to 1), `align` how close
 * the needle is to a station (1 on station), `line` 0 for the carrier and
 * 1 or 2 for the ghosts, `sample` the analyser's sample under this point
 * (-1 to 1; 0 with no analyser), `flat` true during a silence cue. Returns
 * the offset from the wave's baseline, in dial units.
 */
export function waveOffset(u: number, t: number, level: number, align: number, line: number, sample: number, flat: boolean): number {
  if (flat) return 0;
  const env = Math.sin(Math.PI * u);
  const off = line * (1 - align) * 1.7;
  const fr = 9 + line * (1 - align) * 1.3;
  const carrier = REST_CARRIER + level * (0.62 + 0.38 * Math.sin(2 * Math.PI * u * 1.5 + 0.7 + t * 1.3));
  const x = u * (X1 - X0);
  const hiss = (1 - align) * 5 * Math.sin(x * 1.7 + t * 23 + line * 3) * Math.sin(x * 0.31 - t * 7);
  const live = line === 0 ? sample * 34 * align : 0;
  return env * (19 * carrier * Math.sin(2 * Math.PI * fr * u - t * 2.4 + off) + hiss + live);
}

/** What the loop reads each frame (props as refs): set by the page, never a reason to restart the loop. */
export interface Air {
  analyser: AnalyserNode | null;
  /** Audio is playing (not paused, not off air). */
  playing: boolean;
  /** The live line is in its silence: the wave is flat and the meter falls to zero, by hard cut. */
  silent: boolean;
  register: Register;
}

export interface WaveParts {
  canvas: HTMLCanvasElement;
  voiceBar: HTMLElement | null;
  /** The Voice meter itself (role="meter"): its aria-valuenow follows the level, a few times a second. */
  voiceMeter: HTMLElement | null;
  /** The peak hold: a hairline at the loudest recent level, falling back slowly. */
  voicePeak: HTMLElement | null;
  bandLabel: HTMLElement | null;
  /** The needle's closeness to a station, 1 on station (radio.ts). */
  alignment(): number;
  vu: SpringParams;
  tier: PerfTier;
}

/** Reads a colour token as the browser resolves it, through a hidden probe (the canvas takes any CSS colour). */
function tokenColour(host: HTMLElement, token: string): string {
  const probe = document.createElement("span");
  probe.hidden = true;
  probe.style.color = `var(${token})`;
  host.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}

export function mountWave(parts: WaveParts): Air & { redraw(): void } {
  const { canvas, voiceBar, voiceMeter, voicePeak, bandLabel } = parts;
  const ctx = canvas.getContext("2d");
  const detail = waveDetail(parts.tier);
  const host = canvas.parentElement ?? document.body;
  // The glass is lit from behind, so its tokens are the same in both themes (design/spec.md 0.1): read once.
  const amber = tokenColour(host, "--color-glass-amber");
  const glow = tokenColour(host, "--color-glass-amber-glow");
  const ink = tokenColour(host, "--color-glass-ink");
  const air: Air & { redraw(): void } = {
    analyser: null,
    playing: false,
    silent: false,
    register: "telling",
    redraw: () => {
      dirty = true;
      wake();
    },
  };

  let samples = new Float32Array(0);
  let samplesFor: AnalyserNode | null = null;
  let width = 0;
  let height = 0;
  let t = 1.3;
  let last = 0;
  let frame = 0;
  let dirty = true;
  let lastStatic = 0;
  let band = false;
  // Off screen (scrolled away), the loop sleeps until the window is seen again.
  let onScreen = true;
  let shownRegister: Register | null = null;
  const vu = new Spring(parts.vu, 0);
  let peak = 0;
  let meterSaidAt = -Infinity;
  let meterSaid = -1;
  let shownPeak = -1;

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (w !== width || h !== height) {
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
    }
    dirty = true;
    wake();
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(canvas);
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      if (onScreen) {
        dirty = true;
        wake();
      }
    }).observe(canvas);
  }

  const draw = (level: number, align: number) => {
    if (!ctx || !width) return;
    ctx.setTransform(width / VIEW_W, 0, 0, height / VIEW_H, 0, 0);
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const hasSamples = samplesFor !== null && samples.length > 0 && air.playing && !air.silent;
    for (let line = detail.ghosts ? 2 : 0; line >= 0; line--) {
      ctx.beginPath();
      if (line === 0) {
        ctx.strokeStyle = amber;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 1;
        ctx.shadowColor = glow;
        // The glow is a blur the low tier skips.
        ctx.shadowBlur = detail.ghosts ? 8 : 0;
      } else {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1;
        ctx.globalAlpha = line === 1 ? 0.08 + (1 - align) * 0.3 : 0.04 + (1 - align) * 0.22;
        ctx.shadowBlur = 0;
      }
      const span = X1 - X0;
      for (let x = 0; x <= span; x += detail.step) {
        const u = x / span;
        const sample = hasSamples ? samples[Math.floor(u * (samples.length - 1))]! : 0;
        const y = Y0 + waveOffset(u, t, level, align, line, sample, air.silent && air.playing);
        if (x === 0) ctx.moveTo(X0 + x, y);
        else ctx.lineTo(X0 + x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  };

  /** The voice's loudness from the shared analyser, 0 to 1; 0 when nothing plays or in a silence. */
  const level = (): number => {
    const a = air.analyser;
    if (!a || !air.playing || air.silent) return 0;
    if (samplesFor !== a) {
      samples = new Float32Array(a.fftSize);
      samplesFor = a;
    }
    a.getFloatTimeDomainData(samples);
    return loudnessToHeight(toDbfs(rms(samples)));
  };

  const paintMeter = (h: number, dbfs: number, dt: number) => {
    if (!voiceBar) return;
    voiceBar.style.transform = `scaleX(${Math.max(0, Math.min(1, h)).toFixed(3)})`;
    peak = peakHold(peak, Math.max(0, Math.min(1, h)), dt);
    // The meter's value for assistive tech: whole percent, at most four times a second, only on change.
    const now = performance.now();
    const pct = Math.round(Math.max(0, Math.min(1, h)) * 100);
    if (voiceMeter && pct !== meterSaid && now - meterSaidAt >= 250) {
      meterSaid = pct;
      meterSaidAt = now;
      voiceMeter.setAttribute("aria-valuenow", String(pct));
      voiceMeter.setAttribute("aria-valuetext", meterText(pct));
    }
    const p = Math.round(peak * 200) / 2;
    if (voicePeak && p !== shownPeak) {
      shownPeak = p;
      voicePeak.style.left = `${p}%`;
      voicePeak.hidden = p <= 0;
    }
    // The register's hue switches by hard cut (no transition in style.css).
    if (shownRegister !== air.register) {
      shownRegister = air.register;
      voiceBar.style.background = `var(${registerToken(air.register)})`;
    }
    const nowInBand = air.playing && !air.silent && inBand(dbfs);
    if (bandLabel && nowInBand !== band) {
      band = nowInBand;
      bandLabel.hidden = !band;
    }
  };

  const tick = (ms: number) => {
    frame = 0;
    if (!onScreen) {
      // Asleep: the IntersectionObserver wakes it.
      last = 0;
      return;
    }
    if (document.hidden) {
      last = 0;
      frame = requestAnimationFrame(tick);
      return;
    }
    const dt = last ? Math.min((ms - last) / 1000, 0.1) : 1 / 60;
    last = ms;
    const align = parts.alignment();
    const reduce = motion.reduce;
    if (!reduce) {
      t += dt;
      dirty = false;
      const L = level();
      const dbfs = L > 0 ? L * 40 - 40 : -40;
      vu.to(L).step(dt);
      draw(L, align);
      paintMeter(vu.x, dbfs, dt);
      // Playing: every frame. At rest: the drift is drawn about 20 times a
      // second, the loop sleeping on a timer in between rather than polling frames.
      if (air.playing) frame = requestAnimationFrame(tick);
      else rest = window.setTimeout(restWake, REST_FRAME_MS);
      return;
    }
    // Reduced motion: the wave is drawn once and holds still; the meter snaps, four times a second while playing.
    if (dirty || (air.playing && ms - lastStatic > 250)) {
      dirty = false;
      lastStatic = ms;
      const L = level();
      draw(0, align);
      paintMeter(L, L > 0 ? L * 40 - 40 : -40, 0.25);
    }
    if (air.playing) frame = requestAnimationFrame(tick);
    else last = 0;
  };

  let rest = 0;
  /** The rest timer's end: the next frame draws the drift once more. */
  const restWake = () => {
    rest = 0;
    wake();
  };

  function wake() {
    // A wake (playing began, a resize, a tune) cuts the rest short.
    if (rest) {
      clearTimeout(rest);
      rest = 0;
    }
    if (!frame) frame = requestAnimationFrame(tick);
  }

  resize();
  wake();
  return air;
}
