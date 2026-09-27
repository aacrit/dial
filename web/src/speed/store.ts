// This device's measured speed, kept on this device (T7): which engine made
// the speech fastest and how fast, keyed to the voice model's and runtime's
// pins (speed/backend.ts), so the speed test runs once, not on every listen.
// One entry under one key in local storage, written only when the speed
// test (or a graphics chip the browser stopped) gives a new result. It is
// never sent anywhere; /privacy.html says so (tests/privacy-page.test.ts).
// Storage that is blocked or full only means the test runs again next time.

import { parseEntry, type SpeedEntry } from "./backend";

export const SPEED_KEY = "dial.speed";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSpeed(): SpeedEntry | null {
  try {
    return parseEntry(storage()?.getItem(SPEED_KEY));
  } catch {
    return null;
  }
}

export function keepSpeed(entry: SpeedEntry): void {
  try {
    storage()?.setItem(SPEED_KEY, JSON.stringify(entry));
  } catch {
    // Not kept: the test runs again next time.
  }
}
