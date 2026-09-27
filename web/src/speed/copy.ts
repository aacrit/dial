// The words of the no-stall plan (T7): the countdown, the hold, the choice
// past two minutes, and the speed test's result. Every figure in them is
// measured on this device; none is a claim Dial cannot back. No em dashes.

import { speedLabel } from "../bench";
import { aboutMegabytes } from "../download-size";
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

/**
 * The countdown's line under the glass (CoS decision O): the plan is a
 * forecast at four fifths of the measured speed, so it says it should not
 * pause, never that it cannot. After "Start anyway" only the time is said.
 */
export function countdownLine(wait: number, mayPause = false): string {
  if (mayPause) return `Starting in ${countdownClock(wait)}.`;
  return `Starting in ${countdownClock(wait)}. Planned at four fifths of this device's speed, so it should not pause.`;
}

/** The valve's label during a hold. */
export function valveResuming(wait: number): string {
  return `Resuming in ${countdownClock(wait)}`;
}

/** Said while the speed test times its sentence. */
export const TESTING_LINE = "Testing this device: one short sentence on its processor, then on its graphics chip, to find which makes speech faster.";

/** Said when the voice is ready and this device's speed is not known yet: its first line measures it. */
export const MEASURING_LINE = "Making the first line, which measures how fast this device makes speech.";

/** The line under the status until the first line has measured the device. */
export const MEASURING_SHORT = "Measuring how fast this device makes speech.";

/** The line under the status while a short lead (MIN_LEAD_S or less) is made: no countdown, no figure. */
export const SHORT_LEAD_LINE = "Starting in a moment, once the first lines are made.";

/** Said once playback waits for the next line after all (the device slowed down), at a line boundary, never mid-word. */
export const HOLD_LINE = "Making the next line…";

/** The measured speed and the plan, said once the voice is ready. `trials` names the other engine where it was timed too. */
export function planSentence(choice: SpeedChoice, measured: number, planned: number): string {
  const other = choice.trials.find((t) => t.backend !== choice.backend && t.ok && t.rtf > 0);
  const also = other ? ` (${speedLabel(other.rtf)} on ${other.backend === "webgpu" ? "its graphics chip" : "its processor"})` : "";
  const when = choice.cached ? "as measured on an earlier listen" : choice.trials.length ? "measured just now" : "measured from its first line";
  return `This device makes speech at ${speedLabel(measured)} real time on ${engineWords(choice.backend)}${also}, ${when}. Dial plans on ${speedLabel(planned)} to be safe.`;
}

/** The question past two minutes: what waiting would take, and the choices. */
export function choiceQuestion(wait: number, hasRecording: boolean): string {
  // The wait is time spent making, not audio (T7 review).
  const lead = `To play without a pause, this device needs ${countdownClock(wait)} of making before it starts.`;
  return hasRecording ? `${lead} Dial's own recording can play now instead.` : `${lead} You can wait, or start now and let it pause when it needs to.`;
}

/** The graphics chip, offered while the processor makes the work: its model's size is the manifest's, said before anything downloads. */
export function gpuOfferLine(bytes: number): string {
  return `Dial can also test this device's graphics chip, which may be faster. It needs its own copy of the voice, ${aboutMegabytes(bytes)}, downloaded once and kept on this device.`;
}

export function gpuButton(bytes: number): string {
  return `Test the graphics chip (${aboutMegabytes(bytes)})`;
}

/** Its model arriving; the processor keeps making the work meanwhile. */
export function gpuLoadingLine(loaded: number, total: number): string {
  const mb = (n: number) => (n / 1_000_000).toFixed(0);
  return `Downloading the graphics chip's voice: ${mb(loaded)} of ${mb(total)} MB. The processor keeps making the work meanwhile.`;
}

/** The same, short, for the line under the status. */
export function gpuProgress(loaded: number, total: number): string {
  return `Graphics chip's voice: ${(loaded / 1_000_000).toFixed(0)} of ${(total / 1_000_000).toFixed(0)} MB.`;
}

export const GPU_FAILED_LINE = "The graphics chip's voice could not be downloaded or kept, so the processor carries on.";

/** The browser stopped the graphics chip mid-work: the processor carries on, from the line it was making. */
export const GPU_LOST_LINE = "The browser stopped the graphics chip, so this device's processor carries on from the next line, more slowly.";

/** No room for it: the size, and the fix. */
export function gpuNoRoomLine(bytes: number): string {
  return `There is not enough free space on this device for the graphics chip's voice (${aboutMegabytes(bytes)}), so the processor carries on. Free some space, then try again.`;
}

/** The ask's words: the wait past two minutes, the graphics chip's offer, or both. */
export function askLine(o: { wait: number; choice: boolean; hasRecording: boolean; gpuBytes: number }): string {
  const parts = [];
  if (o.choice) parts.push(choiceQuestion(o.wait, o.hasRecording));
  if (o.gpuBytes > 0) parts.push(gpuOfferLine(o.gpuBytes));
  return parts.join(" ");
}

export const PLAY_RECORDING_NOW = "Play Dial's recording now";
export const START_ANYWAY = "Start anyway; it may pause";
