// The no-scroll radio's chrome (design/spec.md 00): the band selector that
// moves between the panels, and the Script / Bookplate widget on the work
// panel, which on a phone held upright fills its panel when Script is
// tapped, with a close key. The panel map itself is panels.ts; the layout is
// style.css. Nothing here fetches or sends anything.

import { motion } from "./device/reduced-motion";
import { PANELS, PHONE_PORTRAIT, SHORT_LANDSCAPE, SINGLE_PANEL, type PanelId } from "./panels";

export type TextTab = "script" | "bookplate";

export interface Panels {
  /** Moves to a panel (instantly under reduced motion, or when `instant`). */
  show(id: PanelId, instant?: boolean): void;
  /** Opens the Script or the Bookplate on the work panel; on a phone the script fills the panel. Focus goes into it. */
  openText(tab: TextTab, opener: HTMLElement | null): void;
  /** Whether the Script tab is the one shown. */
  scriptShown(): boolean;
}

const isPanel = (x: string | undefined): x is PanelId => PANELS.some((p) => p.id === x);

/** Whether a query matches now (false where the browser has no matchMedia). */
const matches = (q: string) => typeof matchMedia === "function" && matchMedia(q).matches;

/**
 * Scrolls a scroller so `el` sits in its middle, moving only that scroller:
 * never the element's own scroll-into-view, which would also move the panels and jump the page.
 */
export function centreWithin(scroller: HTMLElement, el: HTMLElement): void {
  const s = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = scroller.scrollTop + (r.top - s.top) - (s.height - r.height) / 2;
  scroller.scrollTo({ top: Math.max(0, top), behavior: motion.reduce ? "auto" : "smooth" });
}

/** Whether `el` is in view inside its scroller. */
export function inViewWithin(scroller: HTMLElement, el: HTMLElement): boolean {
  const s = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.bottom > s.top && r.top < s.bottom;
}

export function mountPanels(): Panels {
  const scroller = document.querySelector<HTMLElement>("[data-panels]");
  const band = document.getElementById("band");
  const bandStatus = document.getElementById("band-status");
  const widgets = document.getElementById("widgets");
  const text = document.getElementById("w-text");
  const close = document.getElementById("text-close") as HTMLButtonElement | null;
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#w-text [role="tab"]')];
  const keys = band ? [...band.querySelectorAll<HTMLButtonElement>("button[data-to]")] : [];
  const panelEl = (id: PanelId) => document.getElementById(id);

  // ---- the band selector: follows the scroll, and moves it --------------------
  let current: PanelId = "radio";
  const setCurrent = (id: PanelId) => {
    for (const k of keys) k.setAttribute("aria-current", String(k.dataset.to === id));
    if (id === current) return;
    current = id;
    // The panel now in view is said when it changes, never on load.
    if (bandStatus) bandStatus.textContent = `${PANELS.find((p) => p.id === id)!.name} panel`;
  };

  const show = (id: PanelId, instant = false) => {
    const el = panelEl(id);
    if (!el || !scroller) return;
    setCurrent(id);
    // One panel on a large screen: everything is in view already.
    if (matches(SINGLE_PANEL)) return;
    scroller.scrollTo({ top: el.offsetTop, behavior: instant || motion.reduce ? "auto" : "smooth" });
  };

  for (const k of keys) {
    k.addEventListener("click", () => {
      if (isPanel(k.dataset.to)) show(k.dataset.to);
    });
  }
  // Up and Down move between the band's keys, as on a band switch; Home and End go to the ends.
  band?.addEventListener("keydown", (e) => {
    const i = keys.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const to = { ArrowUp: i - 1, ArrowLeft: i - 1, ArrowDown: i + 1, ArrowRight: i + 1, Home: 0, End: keys.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = keys[Math.max(0, Math.min(keys.length - 1, to))]!;
    next.focus();
    if (isPanel(next.dataset.to)) show(next.dataset.to);
  });

  if (scroller && typeof IntersectionObserver === "function") {
    const io = new IntersectionObserver(
      (entries) => {
        if (matches(SINGLE_PANEL)) return;
        for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6 && isPanel(e.target.id)) setCurrent(e.target.id);
      },
      { root: scroller, threshold: [0.6] },
    );
    for (const p of PANELS) {
      const el = panelEl(p.id);
      if (el) io.observe(el);
    }
  }

  // Focus that lands in the other panel (Tab, a sheet closing, a key's opener) brings that panel into view, and the band with it.
  scroller?.addEventListener("focusin", (e) => {
    const p = (e.target as Element).closest<HTMLElement>("[data-panel]");
    if (!p || !isPanel(p.id) || matches(SINGLE_PANEL)) return;
    if (p.id !== current) show(p.id, true);
  });

  // ---- the Script / Bookplate widget --------------------------------------------
  const panelOf = (tab: HTMLButtonElement) => document.getElementById(tab.getAttribute("aria-controls") ?? "");
  const select = (tab: HTMLButtonElement) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const p = panelOf(t);
      if (p) p.hidden = !on;
    }
  };

  /** The script's one tab stop (the live line, else the first), or the Bookplate's scroller. */
  const focusInto = (tab: HTMLButtonElement) => {
    const p = panelOf(tab);
    if (!p) return;
    const line = p.querySelector<HTMLElement>('.sl[tabindex="0"]');
    (line ?? p).focus({ preventScroll: true });
    const live = p.querySelector<HTMLElement>(".sl.live") ?? line;
    if (live) centreWithin(p, live);
  };

  // Filling the panel (a phone held upright only): the other widgets step aside until Close.
  let fillOpener: HTMLElement | null = null;
  const filled = () => widgets?.dataset.fill === "text";
  const fill = (opener: HTMLElement | null) => {
    if (!widgets || !close) return;
    fillOpener = opener;
    widgets.dataset.fill = "text";
    close.hidden = false;
  };
  const unfill = (returnFocus: boolean) => {
    if (!widgets || !close || !filled()) return;
    delete widgets.dataset.fill;
    const hadFocus = text?.contains(document.activeElement) ?? false;
    close.hidden = true;
    const back = fillOpener && fillOpener.isConnected && fillOpener.checkVisibility?.() !== false ? fillOpener : tabs[0];
    fillOpener = null;
    if (!(returnFocus || hadFocus) || !back) return;
    // The key that opened it may be on the other panel: bring that panel into view first, so focus is never off screen.
    const home = back.closest<HTMLElement>("[data-panel]")?.id;
    if (isPanel(home)) show(home, true);
    back.focus({ preventScroll: true });
  };
  close?.addEventListener("click", () => unfill(true));
  text?.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && filled()) {
      e.preventDefault();
      unfill(true);
    }
  });
  // On a phone held upright the open request list covers the work panel: the widgets under it are inert until it closes.
  const reqs = document.getElementById("seal-reqs") as HTMLDetailsElement | null;
  // On a phone on its side it covers the Script column, so that one alone is inert.
  const paintInert = () => {
    const open = !!reqs?.open;
    const phone = open && matches(PHONE_PORTRAIT);
    const side = open && matches(SHORT_LANDSCAPE);
    for (const w of widgets?.querySelectorAll<HTMLElement>(":scope > .widget:not(.w-seal)") ?? []) w.inert = phone || (side && w.classList.contains("w-text"));
  };
  reqs?.addEventListener("toggle", paintInert);

  // Turned on its side, or grown: no longer a phone held upright, so nothing fills or covers.
  if (typeof matchMedia === "function") {
    matchMedia(PHONE_PORTRAIT).addEventListener("change", (e) => {
      if (!e.matches) unfill(false);
      paintInert();
    });
    matchMedia(SHORT_LANDSCAPE).addEventListener("change", paintInert);
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      select(tab);
      // Tapping Script (or the Bookplate) on a phone makes it fill The work panel.
      if (matches(PHONE_PORTRAIT) && !filled()) {
        fill(tab);
        focusInto(tab);
      }
    });
    tab.addEventListener("keydown", (e) => {
      const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const next = tabs[(to + tabs.length) % tabs.length]!;
      select(next);
      next.focus();
    });
  });

  const openText = (which: TextTab, opener: HTMLElement | null) => {
    const tab = document.getElementById(which === "script" ? "tab-script" : "tab-bookplate") as HTMLButtonElement | null;
    if (!tab) return;
    select(tab);
    show("work");
    if (matches(PHONE_PORTRAIT)) fill(opener);
    focusInto(tab);
  };

  // A link to /?panel=work opens on the work panel (the Seal's old links land here).
  if (new URLSearchParams(location.search).get("panel") === "work") requestAnimationFrame(() => show("work", true));

  return {
    show,
    openText,
    scriptShown: () => tabs[0]?.getAttribute("aria-selected") === "true",
  };
}
