// The words of the no-stall plan (T7): the countdown, the hold, the choice
// past two minutes, and the speed test's result. Every figure in them is
// measured on this device; none is a claim Dial cannot back. No em dashes.

import { speedLabel } from "../bench";
import type { SpeedChoice } from "./backend";
import { engineWords } from "./gauge";

/** A countdown's clock: "0:42", "5:03", "1:02:03", whole seconds rounded up (it never reads 0:00 while there is still a wait). */
export function countdownClock(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The valve's label on the glass during the countdown. */
export function valveCountdown(wait: number): string {
  return `Starting in ${countdownClock(wait)}`;
}

/** The countdown's line under the glass. */
export function countdownLine(wait: number): string {
  return `Starting in ${countdownClock(wait)} so it never pauses.`;
}

/** Said while the speed test times its sentence. */
export const TESTING_LINE = "Testing this device: one short sentence, about 3 s, to find how fast it makes speech.";

/** Said once playback waits for the next line after all (the device slowed down), at a line boundary, never mid-word. */
export const HOLD_LINE = "Making the next line…";

/** The measured speed and the plan, said once the voice is ready. `trials` names the other engine where it was timed too. */
export function planSentence(choice: SpeedChoice, measured: number, planned: number): string {
  const other = choice.trials.find((t) => t.backend !== choice.backend && t.ok && t.rtf > 0);
  const also = other ? ` (${speedLabel(other.rtf)} on ${other.backend === "webgpu" ? "its graphics chip" : "its processor"})` : "";
  const when = choice.cached ? "measured here before" : "measured just now";
  return `This device makes speech at ${speedLabel(measured)} real time on ${engineWords(choice.backend)}${also}, ${when}. Dial plans on ${speedLabel(planned)} to be safe.`;
}

/** The question past two minutes: what waiting would take, and the choices. */
export function choiceQuestion(wait: number, hasRecording: boolean): string {
  const lead = `To play without a pause, this device would make the first ${countdownClock(wait)} before starting.`;
  return hasRecording ? `${lead} Dial's own recording can play now instead.` : `${lead} You can wait, or start now and let it pause when it needs to.`;
}

export const PLAY_RECORDING_NOW = "Play Dial's recording now";
export const START_ANYWAY = "Start anyway; it may pause";
