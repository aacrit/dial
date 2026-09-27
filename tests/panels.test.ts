// T8: no-scroll panels (design/spec.md 00). The panel map as layout maths,
// the stylesheet's agreement with it, the no-scroll rule's verdict
// (scripts/lib/layout-probe.mjs judge), and the band selector's markup. The
// same rule runs in a real browser at the six viewports with
// `npm run layout-check`, before a merge.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { judge } from "../scripts/lib/layout-probe.mjs";
import { VIEWPORTS as CHECKED } from "../scripts/layout-check.mjs";
import { LANDSCAPE, PANELS, PHONE_PORTRAIT, QUERIES, SHORT_LANDSCAPE, SINGLE_PANEL, TABLET_PORTRAIT, VIEWPORTS, chrome, dialSize, matchesQuery, panelBox, panelLayout } from "../web/src/panels";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const css = read("web/src/style.css");
const html = read("web/index.html");

/** The body of `@media <query> { ... }` in style.css, brace-matched. */
function mediaBlocks(query: string): string[] {
  const out: string[] = [];
  const head = `@media ${query} {`;
  let at = css.indexOf(head);
  while (at >= 0) {
    let depth = 0;
    let i = at + head.length - 1;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    out.push(css.slice(at + head.length, i));
    at = css.indexOf(head, i);
  }
  return out;
}

/** The declarations of a top-level rule whose selector is exactly `selector`. */
function rule(selector: string, text = css): string {
  // The first rule with this selector alone: never the last line of a selector list (the line before ends with a comma).
  const re = new RegExp(`(?:^|\\n)(?<!,\\n)[ \\t]*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`);
  return re.exec(text)?.[1] ?? "";
}

describe("the panel map (design/spec.md 00)", () => {
  it("each viewport gets the spec's layout", () => {
    const at = (w: number, h: number) => panelLayout(w, h);
    expect(at(375, 812)).toEqual({ panels: ["radio", "work"], snap: true, band: "bottom", work: "stack", scriptFills: true });
    expect(at(768, 1024)).toEqual({ panels: ["radio", "work"], snap: true, band: "bottom", work: "two-columns", scriptFills: false });
    expect(at(1280, 800)).toEqual({ panels: ["radio", "work"], snap: true, band: "right", work: "three-columns", scriptFills: false });
    expect(at(1280, 720)).toEqual(at(1280, 800));
    expect(at(740, 360)).toEqual({ panels: ["radio", "work"], snap: true, band: "right", work: "three-columns", scriptFills: false });
    // Large screens: one panel whenever everything fits; no snapping, no band.
    expect(at(1920, 1080)).toEqual({ panels: ["radio+work"], snap: false, band: "none", work: "side-column", scriptFills: false });
    // Snapping only where there is more than one panel.
    for (const v of VIEWPORTS) {
      const l = at(v.width, v.height);
      expect(l.snap, v.name).toBe(l.panels.length > 1);
      expect(l.band === "none", v.name).toBe(l.panels.length === 1);
    }
  });

  it("the browser check runs at exactly these six viewports", () => {
    expect(CHECKED).toEqual(VIEWPORTS.map((v) => [v.width, v.height]));
  });

  it("reads media queries as CSS does: portrait when the height is at least the width", () => {
    expect(matchesQuery(PHONE_PORTRAIT, 375, 812)).toBe(true);
    expect(matchesQuery(PHONE_PORTRAIT, 740, 360)).toBe(false);
    expect(matchesQuery(TABLET_PORTRAIT, 768, 1024)).toBe(true);
    expect(matchesQuery(LANDSCAPE, 1280, 720)).toBe(true);
    expect(matchesQuery(SHORT_LANDSCAPE, 740, 360)).toBe(true);
    expect(matchesQuery(SHORT_LANDSCAPE, 1280, 720)).toBe(false);
    expect(matchesQuery(SINGLE_PANEL, 1920, 1080)).toBe(true);
    expect(matchesQuery(SINGLE_PANEL, 1920, 800)).toBe(false);
    expect(matchesQuery("(orientation: portrait)", 500, 500)).toBe(true);
    expect(() => matchesQuery("(hover: hover)", 1, 1)).toThrow();
  });

  it("every panel has room: the dial at its spec size on a phone, and never less than its floor anywhere", () => {
    // Phone: "dial (about 350 x 219)".
    const phone = panelBox(375, 812);
    expect(phone.width).toBe(351);
    const d = dialSize(phone.width, 400);
    expect(Math.round(d.width)).toBe(351);
    expect(Math.round(d.height)).toBe(219);
    for (const v of VIEWPORTS) {
      const box = panelBox(v.width, v.height);
      expect(box.width, v.name).toBeGreaterThan(300);
      // The dial box's floor (style.css .dialbox min-height: 110px) plus the tightest side column still fits.
      expect(box.height, v.name).toBeGreaterThan(110 + 150);
      const dial = dialSize(box.width, box.height);
      expect(dial.width, v.name).toBeLessThanOrEqual(box.width);
      expect(dial.height, v.name).toBeLessThanOrEqual(box.height);
    }
    // The dial window keeps its 400 : 250 aspect in a size container.
    expect(rule(".dialbox .dialwin")).toMatch(/width: min\(100cqw, 160cqh\);/);
    expect(rule(".dialbox")).toMatch(/container-type: size;/);
    expect(rule(".dialbox")).toMatch(/min-height: 110px;/);
  });
});

describe("style.css agrees with the map", () => {
  it("carries every query of the map, word for word", () => {
    for (const q of QUERIES) expect(mediaBlocks(q).length, q).toBeGreaterThan(0);
  });

  it("the top bar and band heights are the map's", () => {
    const vars = (block: string) => ({ top: /--top: (\d+)px;/.exec(block)?.[1], band: /--bandh: (\d+)px;/.exec(block)?.[1] });
    expect(vars(rule("body.faceplate-page"))).toEqual({ top: String(chrome(375, 812).top), band: String(chrome(375, 812).band) });
    expect(vars(mediaBlocks(TABLET_PORTRAIT)[0]!)).toEqual({ top: String(chrome(768, 1024).top), band: String(chrome(768, 1024).band) });
    expect(vars(mediaBlocks(LANDSCAPE)[0]!)).toEqual({ top: String(chrome(1280, 800).top), band: String(chrome(1280, 800).band) });
    expect(vars(mediaBlocks(SHORT_LANDSCAPE)[0]!).top).toBe(String(chrome(740, 360).top));
    expect(vars(mediaBlocks(SINGLE_PANEL)[0]!).top).toBe(String(chrome(1920, 1080).top));
    expect(mediaBlocks(LANDSCAPE)[0]).toMatch(/--padr: 84px;/);
    expect(chrome(1280, 800).bandWidth).toBe(84);
  });

  it("the page never scrolls sideways; vertically it snaps panel to panel inside .panels, never body", () => {
    expect(css).toMatch(/html:has\(body\.faceplate-page\),\s*body\.faceplate-page \{\s*height: 100%;\s*overflow: hidden;/);
    const panels = rule(".panels");
    expect(panels).toMatch(/overflow-x: hidden;/);
    expect(panels).toMatch(/scroll-snap-type: y mandatory;/);
    expect(panels).toMatch(/overscroll-behavior: contain;/);
    const panel = rule(".panel");
    expect(panel).toMatch(/height: 100dvh;/);
    expect(panel).toMatch(/scroll-snap-stop: always;/);
    expect(panel).toMatch(/env\(safe-area-inset-top\)/);
    expect(panel).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(css).not.toMatch(/overflow-x: (auto|scroll)/);
    // One panel: no snapping, no band.
    const single = mediaBlocks(SINGLE_PANEL)[0]!;
    expect(single).toMatch(/scroll-snap-type: none;/);
    expect(rule(".band", single)).toMatch(/display: none;/);
  });

  it("long content scrolls inside its own widget, and a flick there never moves the panels", () => {
    expect(rule(".widget .scroll")).toMatch(/overflow: auto;\s*overscroll-behavior: contain;/);
    expect(rule(".reqs")).toMatch(/overflow: auto;\s*overscroll-behavior: contain;/);
    expect(rule(".widget")).toMatch(/min-width: 0;/);
    // Every text-holding flex or grid child may shrink.
    expect(rule(".side")).toMatch(/min-width: 0;/);
    expect(css).toMatch(/\.side > \*,\s*\.display,\s*\.instruments,\s*\.ra-head,\s*\.ra-lines \{\s*min-width: 0;/);
    // The script widget takes the remaining height.
    expect(rule(".widgets")).toMatch(/grid-template-rows: auto auto minmax\(0, 1fr\) auto;/);
  });

  it("on a phone, the open request list and the tapped script fill the work panel; an absolute widget leaves its grid row", () => {
    const phone = mediaBlocks(PHONE_PORTRAIT)[0]!;
    expect(phone).toMatch(/\.w-seal:has\(\.reqs-box\[open\]\) \{\s*position: absolute;\s*inset: 0;\s*z-index: 5;[\s\S]*?grid-area: auto;/);
    expect(phone).toMatch(/\.widgets\[data-fill="text"\] > \.widget:not\(\.w-text\) \{\s*display: none;/);
  });
});

describe("the no-scroll rule's verdict (layout-probe judge)", () => {
  const panel = (parts: object[], over: object = {}) => ({ id: "work", top: 0, bottom: 812, right: 375, padTop: 52, padBottom: 52, padRight: 12, parts, ...over });
  const part = (name: string, top: number, bottom: number, left = 12, right = 363) => ({ name, top, bottom, left, right, width: right - left, height: bottom - top });
  const page = (panels: object[], over: object = {}) => ({ innerWidth: 375, innerHeight: 812, scrollWidth: 375, scrollerScrollWidth: 375, scrollerClientWidth: 375, panels, ...over });

  it("a panel whose parts fit passes", () => {
    expect(judge(page([panel([part("w-about", 52, 300), part("seal", 320, 760)])]))).toEqual({ ok: true, worst: 0, problems: [] });
  });

  it("a part under the band, a page wider than the viewport, a part under the top bar or the band plate: each fails, by how much", () => {
    const under = judge(page([panel([part("seal", 320, 790)])]));
    expect(under.ok).toBe(false);
    expect(under.worst).toBe(30);
    expect(under.problems[0]).toMatch(/^#work seal ends below the panel/);
    expect(judge(page([panel([])], { scrollWidth: 402 })).problems[0]).toMatch(/402 px wide in a 375 px viewport/);
    expect(judge(page([panel([])], { scrollerScrollWidth: 400 })).problems[0]).toMatch(/panels scroll sideways/);
    expect(judge(page([panel([part("dialbox", 20, 200)])])).problems[0]).toMatch(/starts under the top bar/);
    expect(judge(page([panel([part("w-text", 60, 200, 12, 1250)], { right: 1280, padRight: 84 })], { innerWidth: 1280, scrollWidth: 1280, scrollerScrollWidth: 1280, scrollerClientWidth: 1280 })).problems[0]).toMatch(/runs under the band/);
    expect(judge(page([{ id: "radio", missing: true, parts: [] }])).ok).toBe(false);
  });

  it("allows a pixel of rounding, and no more", () => {
    expect(judge(page([panel([part("seal", 320, 760.9)])])).ok).toBe(true);
    expect(judge(page([panel([part("seal", 320, 761.5)])])).ok).toBe(false);
  });
});

describe("the band selector and the rooms", () => {
  it("one key per panel, a lamp in each, the first current; the rooms in the top bar, with no Seal", () => {
    const band = /<nav class="band" id="band" aria-label="Band: move between panels">[\s\S]*?<\/nav>/.exec(html)![0];
    const keys = [...band.matchAll(/<button type="button" data-to="([a-z]+)" aria-current="(true|false)"><span class="lampb" aria-hidden="true"><\/span>([^<]+)<\/button>/g)];
    expect(keys.map((k) => [k[1], k[3]])).toEqual(PANELS.map((p) => [p.id, p.name]));
    expect(keys.map((k) => k[2])).toEqual(["true", "false"]);
    for (const p of PANELS) expect(html).toMatch(new RegExp(`<section class="panel p-[a-z]+" id="${p.id}" data-panel`));
    // The current panel is announced when it changes.
    expect(html).toContain('<p class="visually-hidden" id="band-status" role="status" aria-live="polite"></p>');
    const rooms = /<nav class="rooms" aria-label="Rooms">[\s\S]*?<\/nav>/.exec(html)![0];
    expect(rooms).toContain(">Radio<");
    expect(rooms).not.toMatch(/Seal|Repertory</);
  });

  it("every measured part sits inside a panel", () => {
    const parts = [...html.matchAll(/data-part/g)].length;
    const inPanels = [...html.slice(html.indexOf('id="radio" data-panel'), html.indexOf("</main>")).matchAll(/data-part/g)].length;
    expect(parts).toBeGreaterThan(8);
    expect(inPanels).toBe(parts);
  });

  it("keyboard and motion: the band's keys are buttons that move with the arrows; a band move is instant under reduced motion", () => {
    const ui = read("web/src/panels-ui.ts");
    expect(ui).toMatch(/band\?\.addEventListener\("keydown"/);
    expect(ui).toContain('behavior: instant || motion.reduce ? "auto" : "smooth"');
    // The phone's filled script closes with its key or Esc, and focus goes back to the key that opened it.
    expect(ui).toMatch(/close\?\.addEventListener\("click", \(\) => unfill\(true\)\);/);
    expect(ui).toMatch(/if \(e\.key === "Escape" && filled\(\)\)/);
    expect(ui).toContain("if (returnFocus || hadFocus) back?.focus({ preventScroll: true });");
    // Filling is for a phone held upright only, and ends when it stops being one.
    expect(ui).toMatch(/matchMedia\(PHONE_PORTRAIT\)\.addEventListener\("change"/);
  });

  it("the browser check is its own script, run before a merge and never in the per-commit gate", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts["layout-check"]).toBe("node scripts/layout-check.mjs");
    expect(read("scripts/gate.mjs")).not.toMatch(/layout-check/);
    expect(Object.keys(pkg.devDependencies)).not.toContain("playwright");
  });
});
