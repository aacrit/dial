// The speed gauge on the radio's glass (T7; design/spec.md 00, the Speed
// row, and 0.1, "Speed gauge"): a 0 to 4× needle gauge, the band below real
// time dashed, and under it the measured speed and the engine making the
// speech. It shows only while this device makes a work (rendering, the
// countdown, a hold); Dial's own recording needs no gauge.
//
// Every figure is measured on this device: first by the speed test, then
// from every line as it is made. Nothing here is sent anywhere.
//
// The needle swings on the `swing` spring as the measurement moves; under
// reduced motion it is set at once, with no sweep.

import { gaugeSvg, speedLabel } from "../bench";
import { motion } from "../device/reduced-motion";
import { PRESETS, Spring } from "../device/spring";
import type { Backend } from "./backend";

/** The gauge's scale: 0 to 4× real time; a faster device pins the needle at the top, and the figure says how fast. */
export const GAUGE_MAX = 4;

/** The figure under the gauge: "1.8× real time"; before any measurement, "Measuring". */
export function gaugeReadout(rtf: number): string {
  return rtf > 0 && Number.isFinite(rtf) ? `${speedLabel(rtf)} real time` : "Measuring";
}

/** The engine, as the glass labels it. */
export function engineLabel(backend: Backend): string {
  return backend === "webgpu" ? "Graphics chip" : "Processor";
}

/** The engine, in a sentence: "this device's processor", "this device's graphics chip". */
export function engineWords(backend: Backend): string {
  return backend === "webgpu" ? "this device's graphics chip" : "this device's processor";
}

/** The gauge's accessible name: the figure and the engine in words. */
export function gaugeName(rtf: number, backend: Backend): string {
  const figure = rtf > 0 && Number.isFinite(rtf) ? `${speedLabel(rtf)} real time` : "not measured yet";
  return `Speed of this device: ${figure}, on ${engineWords(backend)}`;
}

/** The meter's aria-valuenow: the speed on the gauge's scale, pinned at its ends (the text carries the real figure). */
export function gaugeValueNow(rtf: number): string {
  const x = Math.max(0, Math.min(GAUGE_MAX, Number.isFinite(rtf) ? rtf : 0));
  return String(Math.round(x * 100) / 100);
}

/** The needle's angle for a speed: -60° at 0, +60° at 4×, pinned at both ends. */
export function needleAngle(rtf: number): number {
  const x = Math.max(0, Math.min(GAUGE_MAX, Number.isFinite(rtf) ? rtf : 0));
  return -60 + x * 30;
}

export interface Gauge {
  /** Shows the gauge for the engine making the speech. */
  show(backend: Backend): void;
  /** The measured speed: the figure changes at once, the needle swings to it. */
  set(rtf: number): void;
  hide(): void;
}

/** Mounts the gauge in its slot on the glass (index.html #speed-gauge). */
export function mountGauge(slot: HTMLElement): Gauge {
  slot.innerHTML = `${gaugeSvg(0)}<span class="il gv" data-numeral></span><span class="il ge"></span>`;
  // A meter, like the Voice meter: its value is the measured speed on the gauge's 0 to 4 scale, its text says it in words.
  slot.setAttribute("role", "meter");
  slot.setAttribute("aria-label", "Speed of this device");
  slot.setAttribute("aria-valuemin", "0");
  slot.setAttribute("aria-valuemax", String(GAUGE_MAX));
  const needle = slot.querySelector<SVGLineElement>(".g-nd")!;
  const value = slot.querySelector<HTMLElement>(".gv")!;
  const engine = slot.querySelector<HTMLElement>(".ge")!;
  const spring = new Spring(PRESETS.swing, needleAngle(0));
  let backend: Backend = "wasm";
  let rtf = 0;
  let frame = 0;
  let last = 0;
  const draw = () => needle.setAttribute("transform", `rotate(${spring.x.toFixed(1)} 60 56)`);
  const step = (t: number) => {
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 1 / 60;
    last = t;
    spring.step(dt, motion.reduce);
    draw();
    frame = spring.resting ? 0 : requestAnimationFrame(step);
  };
  const paint = () => {
    value.textContent = gaugeReadout(rtf);
    engine.textContent = engineLabel(backend);
    slot.setAttribute("aria-valuenow", gaugeValueNow(rtf));
    slot.setAttribute("aria-valuetext", gaugeName(rtf, backend));
    spring.to(needleAngle(rtf));
    if (motion.reduce || slot.hidden) {
      spring.snap();
      draw();
      return;
    }
    if (!frame) {
      last = 0;
      frame = requestAnimationFrame(step);
    }
  };
  return {
    show(next) {
      backend = next;
      slot.hidden = false;
      paint();
    },
    set(next) {
      rtf = next;
      paint();
    },
    hide() {
      slot.hidden = true;
      cancelAnimationFrame(frame);
      frame = 0;
      rtf = 0;
      spring.to(needleAngle(0)).snap();
      draw();
    },
  };
}
