// The no-scroll rule (design/spec.md 00, "Test rule for T8"), in two parts:
// `measure` runs in the page (scripts/layout-check.mjs hands it to the
// browser) and only reads sizes; `judge` is pure and decides, so the rule
// itself is unit-tested without a browser (tests/panels.test.ts).
//
// The rule, at every viewport of the panel map:
// - document.documentElement.scrollWidth <= innerWidth, and the panels'
//   scroller never scrolls sideways;
// - every part of a panel in view (the dial box, each part of the device's
//   side, each widget; marked data-part) sits inside the panel: its bottom is
//   at most the panel's bottom less its bottom padding (clear of the band),
//   its top clear of the top bar, nothing of it under the band selector, and
//   within the viewport.

/** Tolerance for sub-pixel rounding, in px. */
export const SLACK = 1;

/**
 * Runs in the page. `panelIds`: the panels to measure (the one in view, or
 * both on a single-panel screen). Plain data out; nothing is changed.
 */
export function measure(panelIds) {
  const doc = document.documentElement;
  const scroller = document.querySelector("[data-panels]");
  const panels = panelIds.map((id) => {
    const el = document.getElementById(id);
    if (!el) return { id, missing: true, parts: [] };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const parts = [...el.querySelectorAll("[data-part]")]
      .map((p) => {
        const b = p.getBoundingClientRect();
        const name = p.id || p.className.toString().split(" ").filter(Boolean).slice(0, 2).join(".") || p.tagName.toLowerCase();
        return { name, top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
      })
      // Hidden parts (display: none, or a widget stepped aside) take no room.
      .filter((p) => p.width > 0 && p.height > 0);
    return { id, top: r.top, bottom: r.bottom, padTop, padBottom, parts };
  });
  // The band selector, where it is drawn: nothing on a panel may sit under it.
  const bandEl = document.getElementById("band");
  const br = bandEl ? bandEl.getBoundingClientRect() : null;
  const band = br && br.width > 0 && br.height > 0 ? { top: br.top, bottom: br.bottom, left: br.left, right: br.right } : null;
  return {
    band,
    innerWidth,
    innerHeight,
    scrollWidth: doc.scrollWidth,
    scrollerScrollWidth: scroller ? scroller.scrollWidth : 0,
    scrollerClientWidth: scroller ? scroller.clientWidth : 0,
    panels,
  };
}

/** The verdict for one measurement: problems, in plain words, and the worst overflow in px. */
export function judge(m) {
  const problems = [];
  let worst = 0;
  const note = (px, what) => {
    worst = Math.max(worst, px);
    problems.push(`${what} (${px.toFixed(1)} px)`);
  };
  if (m.scrollWidth > m.innerWidth + SLACK) note(m.scrollWidth - m.innerWidth, `the page is ${m.scrollWidth} px wide in a ${m.innerWidth} px viewport`);
  if (m.scrollerScrollWidth > m.scrollerClientWidth + SLACK) note(m.scrollerScrollWidth - m.scrollerClientWidth, "the panels scroll sideways");
  for (const p of m.panels) {
    if (p.missing) {
      problems.push(`panel #${p.id} is missing`);
      continue;
    }
    const floor = p.bottom - p.padBottom;
    const ceiling = p.top + (p.padTop ?? 0);
    for (const part of p.parts) {
      if (part.bottom > floor + SLACK) note(part.bottom - floor, `#${p.id} ${part.name} ends below the panel`);
      if (part.top < ceiling - SLACK) note(ceiling - part.top, `#${p.id} ${part.name} starts under the top bar`);
      if (part.right > m.innerWidth + SLACK) note(part.right - m.innerWidth, `#${p.id} ${part.name} runs off the right edge`);
      const b = m.band;
      if (b) {
        // How far the part reaches into the band plate, the lesser of the two overlaps.
        const across = Math.min(part.right, b.right) - Math.max(part.left, b.left);
        const down = Math.min(part.bottom, b.bottom) - Math.max(part.top, b.top);
        if (across > SLACK && down > SLACK) note(Math.min(across, down), `#${p.id} ${part.name} runs under the band`);
      }
      if (part.left < -SLACK) note(-part.left, `#${p.id} ${part.name} runs off the left edge`);
    }
  }
  return { ok: problems.length === 0, worst, problems };
}
