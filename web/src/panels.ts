// The no-scroll panel map (design/spec.md 00), as pure functions. A room is
// one or more full-viewport panels; the band selector moves between them.
// The media queries below are the ones web/src/style.css uses, word for
// word (tests/panels.test.ts checks), so the page and this map agree on
// which layout a viewport gets. No DOM here: panels-ui.ts wires it up.

/** The panels of the radio, in order: the device, then the work's widgets. */
export const PANELS = [
  { id: "radio", name: "Radio" },
  { id: "work", name: "The work" },
] as const;

export type PanelId = (typeof PANELS)[number]["id"];

/** A phone held upright: the band at the bottom, the work's widgets stacked, the script expands to fill its panel. */
export const PHONE_PORTRAIT = "(max-width: 767px) and (orientation: portrait)";
/** A tablet held upright: the band at the bottom, the work's widgets in two columns. */
export const TABLET_PORTRAIT = "(min-width: 768px) and (orientation: portrait)";
/** Any landscape screen: the dial on the left, the band a vertical plate at the right edge. */
export const LANDSCAPE = "(orientation: landscape)";
/** A phone on its side and other short screens: everything tighter. */
export const SHORT_LANDSCAPE = "(orientation: landscape) and (max-height: 500px)";
/** Large screens: one panel, no snapping, no band (founder, 2026-09-27: "whenever everything fits"). */
export const SINGLE_PANEL = "(min-width: 1600px) and (min-height: 900px)";

/** Every query the stylesheet must carry, as written there. */
export const QUERIES = [PHONE_PORTRAIT, TABLET_PORTRAIT, LANDSCAPE, SHORT_LANDSCAPE, SINGLE_PANEL] as const;

/** The six viewports the design was checked at, and the enforced layout check runs at. */
export const VIEWPORTS = [
  { width: 375, height: 812, name: "phone" },
  { width: 768, height: 1024, name: "tablet" },
  { width: 1280, height: 800, name: "laptop" },
  { width: 1280, height: 720, name: "laptop-short" },
  { width: 1920, height: 1080, name: "desktop" },
  { width: 740, height: 360, name: "phone-landscape" },
] as const;

/**
 * Whether a viewport matches one of the queries above: features joined by
 * "and", each (min|max)-(width|height): <n>px or orientation. Orientation
 * is portrait when the height is at least the width, as in CSS.
 */
export function matchesQuery(query: string, width: number, height: number): boolean {
  return query.split(/\s+and\s+/).every((part) => {
    const m = /^\((min|max)-(width|height):\s*(\d+)px\)$/.exec(part.trim());
    if (m) {
      const v = m[2] === "width" ? width : height;
      return m[1] === "min" ? v >= Number(m[3]) : v <= Number(m[3]);
    }
    const o = /^\(orientation:\s*(portrait|landscape)\)$/.exec(part.trim());
    if (o) return (o[1] === "portrait") === height >= width;
    throw new Error(`matchesQuery: unsupported feature ${part}`);
  });
}

export interface PanelLayout {
  /** The panels drawn, top to bottom; one entry when everything is on one screen. */
  panels: readonly (PanelId | "radio+work")[];
  /** Whether the panels scroll-snap (only with more than one). */
  snap: boolean;
  /** Where the band selector sits, or none on a single panel. */
  band: "bottom" | "right" | "none";
  /** How the work's widgets are arranged. */
  work: "stack" | "two-columns" | "three-columns" | "side-column";
  /** Whether tapping Script makes the script fill its panel (a phone held upright). */
  scriptFills: boolean;
}

/** The layout a viewport gets (design/spec.md 00, the panel map). */
export function panelLayout(width: number, height: number): PanelLayout {
  if (matchesQuery(SINGLE_PANEL, width, height)) return { panels: ["radio+work"], snap: false, band: "none", work: "side-column", scriptFills: false };
  const panels = ["radio", "work"] as const;
  if (matchesQuery(PHONE_PORTRAIT, width, height)) return { panels, snap: true, band: "bottom", work: "stack", scriptFills: true };
  if (matchesQuery(TABLET_PORTRAIT, width, height)) return { panels, snap: true, band: "bottom", work: "two-columns", scriptFills: false };
  return { panels, snap: true, band: "right", work: "three-columns", scriptFills: false };
}

/** The top bar's and the band's heights, in px, per layout (style.css --top and --bandh). */
export function chrome(width: number, height: number): { top: number; band: number; bandWidth: number } {
  const l = panelLayout(width, height);
  if (l.band === "none") return { top: 60, band: 0, bandWidth: 0 };
  if (l.band === "right") return { top: matchesQuery(SHORT_LANDSCAPE, width, height) ? 38 : 56, band: 0, bandWidth: 84 };
  return matchesQuery(TABLET_PORTRAIT, width, height) ? { top: 60, band: 52, bandWidth: 0 } : { top: 48, band: 44, bandWidth: 0 };
}

/**
 * A panel's content box: the viewport less the top bar, the band and the
 * padding style.css gives .panel (4 px under the top bar, 8 px over the
 * band, 12 px at the sides or the band plate's 84 px at the right).
 * Safe-area insets are 0 in a desktop browser.
 */
export function panelBox(width: number, height: number): { width: number; height: number } {
  const c = chrome(width, height);
  const right = c.bandWidth || 12;
  return { width: width - 12 - right, height: height - c.top - 4 - c.band - 8 };
}

/** The dial window's size in a box: as wide as it may be, no taller than the box (aspect 400 : 250). */
export function dialSize(boxWidth: number, boxHeight: number): { width: number; height: number } {
  const width = Math.max(0, Math.min(boxWidth, boxHeight * 1.6));
  return { width, height: Math.min(boxHeight, width / 1.6) };
}
