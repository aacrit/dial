// Installing Dial as an app (design/spec.md 2). After a first completed
// listen in this visit:
// - where the browser offers an install prompt (beforeinstallprompt:
//   Chrome, Edge, Android), the "Keep Dial on this device" card with
//   Install, the only Install button Dial ever shows;
// - on iPhone and iPad Safari, which have no prompt, the Add to Home
//   Screen steps and the week-without-a-visit note, with no Install button,
//   because none would work.
// "Not now" hides the card for 30 days. That date is the one thing this
// module keeps: a single entry in the browser's Cache Storage on this
// device (DEVICE_CACHE), never sent.

export const INSTALL_SNOOZE_DAYS = 30;
export const DEVICE_CACHE = "dial-device";
const NOT_NOW_KEY = "/device/install-not-now";
const DAY_MS = 86_400_000;

export type InstallCard = "prompt" | "ios" | null;

export interface InstallInput {
  /** A work finished playing in this visit. */
  listened: boolean;
  /** Dial is already running as an installed app. */
  standalone: boolean;
  /** The browser fired beforeinstallprompt and it has not been used. */
  promptAvailable: boolean;
  /** iPhone or iPad Safari (no install prompt exists there). */
  iosSafari: boolean;
  /** When "Not now" was last pressed, in ms since the epoch, if ever. */
  notNowAt: number | null;
  now: number;
}

/** Which card, if any: only after a completed listen, never in the installed app, and not within 30 days of "Not now". */
export function installCard(i: InstallInput): InstallCard {
  if (!i.listened || i.standalone) return null;
  if (i.notNowAt !== null && i.now - i.notNowAt < INSTALL_SNOOZE_DAYS * DAY_MS) return null;
  if (i.promptAvailable) return "prompt";
  if (i.iosSafari) return "ios";
  return null;
}

/** iPhone or iPad Safari, including iPadOS reporting itself as a Mac, and not another browser's shell. */
export function isIosSafari(ua: string, maxTouchPoints: number): boolean {
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  return ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

export async function readNotNow(): Promise<number | null> {
  try {
    const hit = await (await caches.open(DEVICE_CACHE)).match(NOT_NOW_KEY);
    const at = hit ? Number(await hit.text()) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

export async function writeNotNow(at: number): Promise<void> {
  try {
    await (await caches.open(DEVICE_CACHE)).put(NOT_NOW_KEY, new Response(String(at)));
  } catch {
    // Not kept: the card may show again next visit.
  }
}
