// The save row, the offline notice and the install cards (design/spec.md 2).
// The row follows the tuned station and always carries a label:
//   Save for offline, with what it will store
//   -> Saving… 48.2 of 114.6 MB, a progress line and Cancel
//   -> Saved for offline, what it occupies, and Remove.
// Offline, a work not saved says so. Every line is set only once code has
// confirmed it (a work is "Saved" only when its text, its voice files and
// the app's own files are all on this device). Text is set with
// textContent, never markup, so no value is read as HTML.

import type { Work } from "../catalogue";
import { installCard, isIosSafari, readNotNow, writeNotNow } from "./install";
import {
  OFFLINE_NOTICE,
  SAVED_OLDER,
  SAVED_OLDER_LINE,
  SAVE_OFFLINE_NOT_SAVED,
  savedState,
  offlineExtras,
  onDeviceBytes,
  planTotal,
  saveFailedLine,
  savedLine,
  savingLine,
  sizeLine,
  workVoices,
  type SavePlan,
} from "./plan";
import { PAGE_KEY, coverVoiceRecord, isPersisted, offlineWorks, planFor, readManifest, removeWork, requestPersistence, saveWork, savedSlugs, shellState, type Manifest } from "./store";

type RowState =
  | { kind: "idle"; plan: SavePlan; error?: string }
  | { kind: "saving"; loaded: number; total: number; ctrl: AbortController }
  | { kind: "saved"; bytes: number; persisted: boolean }
  | { kind: "older" }
  | { kind: "unsaved-offline" };

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

export interface OfflineHooks {
  /** The tuned work. */
  tuned(): Work;
  /** A work's text and its cast's voices, when its text is on this page. */
  textOf(slug: string): { source: string; voices: readonly string[] } | undefined;
}

/** Splits "48.2 of 114.6 MB" into text and data-face numerals. */
function setNumerals(el: HTMLElement, text: string): void {
  el.replaceChildren();
  for (const part of text.split(/(\d[\d,.]*\d|\d)/)) {
    if (!part) continue;
    if (/^\d/.test(part)) {
      const n = document.createElement("span");
      n.dataset.numeral = "";
      n.textContent = part;
      el.append(n);
    } else el.append(part);
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) setNumerals(e, text);
  return e;
};

export function mountOffline(hooks: OfflineHooks) {
  const row = document.getElementById("save-row");
  const announcer = document.getElementById("save-status");
  const notice = document.getElementById("offline-note");
  const noticeText = document.getElementById("offline-note-text");
  const installBox = document.getElementById("install-card");
  const installYes = document.getElementById("install-yes") as HTMLButtonElement | null;
  const installNo = document.getElementById("install-no") as HTMLButtonElement | null;
  const iosBox = document.getElementById("ios-card");
  const iosSaved = document.getElementById("ios-saved-note");
  const iosNo = document.getElementById("ios-no") as HTMLButtonElement | null;
  const states = new Map<string, RowState>();
  let manifest: Manifest | null = null;
  let offline = !navigator.onLine;
  let listened = false;
  let deferredPrompt: BeforeInstallPromptEvent | null = null;
  // Unknown until the probe answers: the row stays hidden until offline is known to work here.
  let supported = false;

  // ---- the save row ---------------------------------------------------------
  /** Said once per change of state (the row's numbers are not announced). */
  const say = (line: string) => {
    if (announcer && announcer.textContent !== line) announcer.textContent = line;
  };

  const paint = () => {
    if (!row) return;
    const w = hooks.tuned();
    const state = states.get(w.slug);
    // While saving, only the numbers move: the row is not rebuilt, so focus and the reader stay put.
    if (state?.kind === "saving" && row.dataset.kind === "saving" && row.dataset.slug === w.slug) {
      const sz = row.querySelector<HTMLElement>(".sz");
      const bar = row.querySelector("progress");
      if (sz) setNumerals(sz, savingLine(state.loaded, state.total).replace(/^Saving… /, ""));
      if (bar) {
        bar.max = Math.max(1, state.total);
        bar.value = Math.min(state.loaded, state.total);
      }
      return;
    }
    row.dataset.kind = state?.kind ?? "";
    row.dataset.slug = w.slug;
    const hadFocus = row.contains(document.activeElement);
    row.replaceChildren();
    row.hidden = !supported || !state;
    if (!state) return;
    let focusTarget: HTMLButtonElement | null = null;
    if (state.kind === "idle") {
      const b = el("button", "btn quiet", "Save for offline");
      b.type = "button";
      b.addEventListener("click", () => void save(w));
      row.append(b, el("span", "sz", sizeLine(state.plan)));
      if (state.error) row.append(el("p", "save-error", state.error));
      focusTarget = b;
    } else if (state.kind === "saving") {
      row.append(el("span", "ok", "Saving…"), el("span", "sz", savingLine(state.loaded, state.total).replace(/^Saving… /, "")));
      const bar = el("progress", "bar");
      bar.max = Math.max(1, state.total);
      bar.value = Math.min(state.loaded, state.total);
      bar.setAttribute("aria-label", `Saving ${w.called} for offline`);
      const cancel = el("button", "btn text", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => state.ctrl.abort());
      row.append(bar, cancel);
      focusTarget = cancel;
    } else if (state.kind === "saved") {
      const ok = el("span", "ok");
      const pip = el("span", "pip eye");
      pip.setAttribute("aria-hidden", "true");
      ok.append(pip, "Saved for offline");
      const sz = el("span", "sz", savedLine(state.bytes, state.persisted));
      const remove = el("button", "btn text", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${w.called} from this device`);
      remove.addEventListener("click", () => void remove_(w));
      row.append(ok, sz, remove);
      focusTarget = remove;
    } else if (state.kind === "older") {
      const remove = el("button", "btn text", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${w.called} from this device`);
      remove.addEventListener("click", () => void remove_(w));
      row.append(el("span", "ok", SAVED_OLDER), el("span", "sz", SAVED_OLDER_LINE), remove);
      focusTarget = remove;
    } else {
      row.append(el("span", "ok", "Not saved"), el("span", "sz", SAVE_OFFLINE_NOT_SAVED));
    }
    if (hadFocus) (focusTarget ?? document.getElementById("tune-in"))?.focus();
  };

  /** Works out the tuned station's row from what is on this device. */
  const refresh = async (slug: string) => {
    const cur = states.get(slug);
    if (cur?.kind === "saving") return;
    const text = hooks.textOf(slug);
    const savedNow = await savedSlugs().catch(() => new Set<string>());
    if (!text) {
      // No text on this page: offline, the work is not saved here; online, its text did not arrive, so the row waits.
      if (offline && !savedNow.has(slug)) states.set(slug, { kind: "unsaved-offline" });
      else states.delete(slug);
      if (hooks.tuned().slug === slug) paint();
      return;
    }
    try {
      manifest ??= await readManifest();
      const voices = workVoices(text.voices);
      const textBytes = new TextEncoder().encode(text.source).byteLength;
      // A saved work's record keeps covering today's cast (a recast may add a voice).
      await coverVoiceRecord(slug, voices);
      const plan = await planFor(manifest, slug, voices, textBytes);
      const saved = savedState(plan, await shellState(), PAGE_KEY);
      if (saved === "older") states.set(slug, { kind: "older" });
      else if (saved === "saved") {
        const extras = offlineExtras(manifest.manifest).map((p) => ({ path: p, bytes: p === "/voice/manifest.json" ? manifest!.bytes : (manifest!.manifest.sizes[p] ?? 0) }));
        states.set(slug, { kind: "saved", bytes: onDeviceBytes(manifest.manifest, voices, textBytes, extras), persisted: await isPersisted() });
      } else if (offline) states.set(slug, { kind: "unsaved-offline" });
      else states.set(slug, { kind: "idle", plan, error: cur?.kind === "idle" ? cur.error : undefined });
    } catch {
      // The manifest could not be read (offline, nothing saved): the row says what is true.
      if (offline) states.set(slug, { kind: "unsaved-offline" });
      else states.delete(slug);
    }
    if (hooks.tuned().slug === slug) paint();
  };

  const save = async (w: Work) => {
    const text = hooks.textOf(w.slug);
    const cur = states.get(w.slug);
    if (!text || cur?.kind !== "idle" || !manifest) return;
    const firstSave = (await savedSlugs().catch(() => new Set<string>())).size === 0;
    const ctrl = new AbortController();
    const saving: RowState = { kind: "saving", loaded: 0, total: planTotal(cur.plan), ctrl };
    states.set(w.slug, saving);
    paint();
    say(`Saving ${w.called} for offline.`);
    // Asked on the first save; where the browser declines, the saved line says so.
    if (firstSave) await requestPersistence();
    let last = 0;
    try {
      await saveWork(manifest, w.slug, text.source, workVoices(text.voices), ctrl.signal, (loaded) => {
        saving.loaded = loaded;
        // Repaint at most every 100 ms: the numbers move, the focus stays.
        const now = performance.now();
        if (now - last > 100 && hooks.tuned().slug === w.slug) {
          last = now;
          paint();
        }
      });
      states.delete(w.slug);
      await refresh(w.slug);
      say(states.get(w.slug)?.kind === "saved" ? `Saved ${w.called} for offline.` : `${w.called.charAt(0).toUpperCase()}${w.called.slice(1)} was not saved on this device.`);
    } catch (err) {
      const cancelled = ctrl.signal.aborted;
      states.delete(w.slug);
      await refresh(w.slug);
      const after = states.get(w.slug);
      if (cancelled) say(`Saving ${w.called} was cancelled.`);
      else if (after?.kind === "idle") {
        after.error = saveFailedLine(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        say(after.error);
        if (hooks.tuned().slug === w.slug) paint();
      }
    }
  };

  const remove_ = async (w: Work) => {
    if (!manifest) return;
    // Today's cast of every other work whose text is here: a voice one of them needs is never removed.
    const today = new Map<string, readonly string[]>();
    for (const slug of await savedSlugs()) {
      const t = slug === w.slug ? undefined : hooks.textOf(slug);
      if (t) today.set(slug, workVoices(t.voices));
    }
    await removeWork(manifest.manifest, w.slug, today);
    states.delete(w.slug);
    await refresh(w.slug);
    say(`Removed ${w.called} from this device.`);
  };

  // ---- offline notice -------------------------------------------------------
  const paintNotice = () => {
    if (!notice || !noticeText) return;
    notice.hidden = !offline;
    noticeText.textContent = OFFLINE_NOTICE;
  };
  const onLine = () => {
    offline = !navigator.onLine;
    paintNotice();
    void refresh(hooks.tuned().slug);
  };
  window.addEventListener("online", onLine);
  window.addEventListener("offline", onLine);
  paintNotice();

  // ---- install --------------------------------------------------------------
  const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const paintInstall = async () => {
    if (!installBox || !iosBox) return;
    const card = installCard({
      listened,
      standalone: standalone(),
      promptAvailable: !!deferredPrompt,
      iosSafari: isIosSafari(navigator.userAgent, navigator.maxTouchPoints),
      notNowAt: await readNotNow(),
      now: Date.now(),
    });
    const leaving = (installBox.contains(document.activeElement) && card !== "prompt") || (iosBox.contains(document.activeElement) && card !== "ios");
    installBox.hidden = card !== "prompt";
    iosBox.hidden = card !== "ios";
    // What happens to saved works is said only where saving works at all.
    if (iosSaved) iosSaved.hidden = card !== "ios" || !(await offlineWorks());
    if (leaving) document.getElementById("tune-in")?.focus();
  };
  window.addEventListener("beforeinstallprompt", (e) => {
    // Held until after a first completed listen; Install shows only while it exists.
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    void paintInstall();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    void paintInstall();
  });
  installYes?.addEventListener("click", async () => {
    const p = deferredPrompt;
    if (!p) return;
    deferredPrompt = null;
    await p.prompt();
    await p.userChoice.catch(() => undefined);
    void paintInstall();
  });
  const notNow = async () => {
    await writeNotNow(Date.now());
    await paintInstall();
  };
  installNo?.addEventListener("click", () => void notNow());
  iosNo?.addEventListener("click", () => void notNow());

  return {
    /** The needle moved, or the texts arrived: repaint the row from the device. */
    station: () => {
      if (!row) return;
      if (!supported) {
        // Where the helper cannot serve the render worker, no offline promise is made.
        void offlineWorks().then((ok) => {
          if (!ok || supported) return;
          supported = true;
          paint();
          void refresh(hooks.tuned().slug);
        });
        return;
      }
      paint();
      void refresh(hooks.tuned().slug);
    },
    /** A work finished playing: the install card may now show. */
    listened: () => {
      listened = true;
      void paintInstall();
    },
    isOffline: () => offline,
  };
}
