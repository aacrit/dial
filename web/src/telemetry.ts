// The one sender of counts. Telemetry here is aggregate counts only: no
// anonymous id, no cookie, nothing that could identify a visitor. `/e`
// accepts exactly `{ "name": "<allowed event>" }` and bumps a same-day,
// same-name counter. Every POST is same-origin JSON: the Worker refuses
// anything else (worker/src/guard.ts), so never use sendBeacon, which sends
// text/plain.
//
// The listener can turn counts off on the Seal. The setting is the one
// thing Dial keeps in local storage, under COUNTS_KEY, and sendEvent reads it
// before every send: off means nothing is posted at all (web/privacy.html;
// tests/seal.test.ts). Feedback is not a count: it is sent only when the
// listener submits the form, whatever this switch says.

import { noteSend, noteSendFailed, type SendToken } from "./request-recorder";

export const COUNTS_KEY = "dial.counts";

/** Beside the disabled switch, when the browser will not keep the setting. */
export const STORAGE_REFUSED = "This browser will not keep the setting, so Dial cannot turn counts off here.";

/** The part of Storage this module uses. */
export interface SettingStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function localStore(): SettingStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Whether counts are sent: on unless the listener turned them off. */
export function countsOn(store: SettingStore | null = localStore()): boolean {
  try {
    return store?.getItem(COUNTS_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Whether this browser lets Dial keep the setting at all (without writing anything to find out). */
export function canKeepSetting(store: SettingStore | null = localStore()): boolean {
  if (!store) return false;
  try {
    store.getItem(COUNTS_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns counts on or off. Returns whether the setting was kept on this
 * device. When it was not, nothing changes: counts stay as they were, and
 * the Seal disables the switch and says why.
 */
export function setCounts(on: boolean, store: SettingStore | null = localStore()): boolean {
  try {
    if (!store) return false;
    store.setItem(COUNTS_KEY, on ? "on" : "off");
    return true;
  } catch {
    return false;
  }
}

export interface SendDeps {
  fetch: (input: string, init: RequestInit) => Promise<unknown>;
  store: SettingStore | null;
  /** Records the send in the Seal's log before it posts. */
  note: (path: string, bytes: number, event?: string) => SendToken | undefined;
  /** Marks that send "not delivered" when the network failed. */
  failed: (token: SendToken) => void;
}

const defaults = (): SendDeps => ({ fetch: globalThis.fetch.bind(globalThis), store: localStore(), note: noteSend, failed: noteSendFailed });

/** Posts one count, unless counts are off. */
export function sendEvent(name: string, deps: SendDeps = defaults()): void {
  if (!countsOn(deps.store)) return;
  const body = JSON.stringify({ name });
  const token = deps.note("/e", new TextEncoder().encode(body).length, name);
  deps
    .fetch("/e", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    })
    .catch(() => {
      // Best-effort telemetry: a failed send is not the user's problem. The
      // Seal's log says it was not delivered.
      if (token) deps.failed(token);
    });
}
