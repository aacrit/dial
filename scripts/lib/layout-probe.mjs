// The no-scroll rule (design/spec.md 00, "Test rule for T8"; CoS decision F,
// 2026-09-27), in two parts: `measure` runs in the page
// (scripts/layout-check.mjs hands it to the browser) and only reads sizes;
// `judge` is pure and decides, so the rule itself is unit-tested without a
// browser (tests/panels.test.ts).
//
// The rule:
// - Never sideways: document.documentElement.scrollWidth <= innerWidth, and
//   the panels' scroller never scrolls sideways.
// - Nothing is ever unreachable: every visible control and every non-empty
//   text in a panel (or an open sheet) lies inside its nearest clipping
//   ancestor's box, or inside a scroller that can bring it into view; every
//   such scroller is at least 24 px tall. Text cut short on purpose (a
//   line clamp) is exempt. The knobs and keys on the device never overlap.
// - Fit, at the panel map's own viewports: every part of a panel in view
//   (the dial box, each part of the device's side, each widget; marked
//   data-part) sits inside the panel, clear of the top bar and the band, so
//   nothing needs the panel's own scroll there. At other sizes a panel may
//   scroll vertically inside itself (decision F): reachable, never clipped.

/** Tolerance for sub-pixel rounding, in px. */
export const SLACK = 1;

/** The smallest inner scroller that counts as a way to reach its content, in px. */
export const MIN_SCROLLER = 24;

/**
 * Runs in the page. `rootIds`: the panels to measure (the one in view, or
 * both on a single-panel screen), or an open sheet. Plain data out; nothing
 * is changed. Self-contained: the browser receives it as source.
 */
export function measure(rootIds) {
  const SLACK_IN = 1;
  const MIN_IN = 24;
  const doc = document.documentElement;
  const scroller = document.querySelector("[data-panels]");
  const name = (el) => {
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32);
    const tag = el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className ? `.${el.className.split(" ").filter(Boolean).slice(0, 2).join(".")}` : ""}`;
    return text ? `${tag} "${text}"` : tag;
  };
  const clamped = (el) => {
    for (let a = el, i = 0; a && i < 4; a = a.parentElement, i++) {
      const lc = getComputedStyle(a).webkitLineClamp;
      if (lc && lc !== "none") return true;
    }
    return false;
  };
  /** Why a box at `r` inside `el` cannot be seen or reached, or null. */
  const unreachable = (el, r) => {
    for (let a = el.parentElement; a && a !== document.body && a !== doc; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const ar = a.getBoundingClientRect();
      const scrollsY = cs.overflowY === "auto" || cs.overflowY === "scroll";
      const scrollsX = cs.overflowX === "auto" || cs.overflowX === "scroll";
      const below = r.bottom - ar.bottom;
      const above = ar.top - r.top;
      const right = r.right - ar.right;
      const left = ar.left - r.left;
      if (!scrollsX && (right > SLACK_IN || left > SLACK_IN)) return { why: `${name(a)} clips it by ${Math.max(right, left).toFixed(0)} px sideways`, px: Math.max(right, left) };
      if (!scrollsY && (below > SLACK_IN || above > SLACK_IN)) return { why: `${name(a)} clips it by ${Math.max(below, above).toFixed(0)} px`, px: Math.max(below, above) };
      if (scrollsY) {
        // Reachable by scrolling this box, if the box itself can be seen and is tall enough to scroll through.
        if (ar.height < MIN_IN) return { why: `its scroller ${name(a)} is only ${ar.height.toFixed(0)} px tall`, px: MIN_IN - ar.height };
        return unreachable(a, ar);
      }
    }
    return null;
  };

  const rootData = rootIds.map((id) => {
    const el = document.getElementById(id);
    if (!el) return { id, missing: true, parts: [], clips: [], overlaps: [] };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const parts = [...el.querySelectorAll("[data-part]")]
      .map((p) => {
        const b = p.getBoundingClientRect();
        return { name: p.id || p.className.toString().split(" ").filter(Boolean).slice(0, 2).join(".") || p.tagName.toLowerCase(), top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
      })
      // Hidden parts (display: none, or a widget stepped aside) take no room.
      .filter((p) => p.width > 0 && p.height > 0);

    // Every visible control, and every non-empty run of text.
    const clips = [];
    const seen = new Set();
    const check = (target, box, interactive) => {
      if (box.width === 0 || box.height === 0 || clamped(target)) return;
      const u = unreachable(target, box);
      if (!u) return;
      const key = `${name(target)}|${u.why}`;
      if (seen.has(key)) return;
      seen.add(key);
      clips.push({ el: name(target), interactive, why: u.why, px: u.px });
    };
    const controls = 'a[href], button, input, textarea, select, summary, [tabindex="0"], [role="slider"], [role="switch"], [role="tab"]';
    // Text kept for assistive technology only (.visually-hidden) is clipped on purpose.
    const skip = (x) => !x.checkVisibility({ visibilityProperty: true }) || x.closest(".visually-hidden");
    for (const c of el.querySelectorAll(controls)) {
      if (skip(c)) continue;
      check(c, c.getBoundingClientRect(), true);
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const host = n.parentElement;
      if (!host || host.closest("svg") || skip(host)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      check(host, range.getBoundingClientRect(), false);
    }

    // The device's knobs and keys never overlap one another.
    const overlaps = [];
    for (const row of el.querySelectorAll(".controls")) {
      const items = [...row.querySelectorAll(".knob, .key")].filter((k) => k.checkVisibility()).map((k) => ({ n: name(k), r: k.getBoundingClientRect() }));
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i].r;
          const b = items[j].r;
          const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (across > SLACK_IN && down > SLACK_IN) overlaps.push({ a: items[i].n, b: items[j].n, px: across });
        }
      }
    }
    return { id, top: r.top, bottom: r.bottom, padTop, padBottom, parts, clips, overlaps };
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
    panels: rootData,
  };
}

/**
 * The verdict for one measurement: problems, in plain words, the worst
 * overflow in px, and how many things were clipped. `fit`: whether this
 * viewport is one of the panel map's, where every part must fit unscrolled.
 */
export function judge(m, { fit = true } = {}) {
  const problems = [];
  let worst = 0;
  let clipped = 0;
  const note = (px, what) => {
    worst = Math.max(worst, px);
    problems.push(`${what} (${px.toFixed(1)} px)`);
  };
  if (m.scrollWidth > m.innerWidth + SLACK) note(m.scrollWidth - m.innerWidth, `the page is ${m.scrollWidth} px wide in a ${m.innerWidth} px viewport`);
  if (m.scrollerScrollWidth > m.scrollerClientWidth + SLACK) note(m.scrollerScrollWidth - m.scrollerClientWidth, "the panels scroll sideways");
  for (const p of m.panels) {
    if (p.missing) {
      problems.push(`#${p.id} is missing`);
      continue;
    }
    for (const c of p.clips ?? []) {
      clipped++;
      note(c.px, `#${p.id} ${c.interactive ? "control" : "text"} ${c.el} cannot be reached: ${c.why}`);
    }
    for (const o of p.overlaps ?? []) note(o.px, `#${p.id} ${o.a} overlaps ${o.b}`);
    for (const part of p.parts) {
      if (part.right > m.innerWidth + SLACK) note(part.right - m.innerWidth, `#${p.id} ${part.name} runs off the right edge`);
      if (part.left < -SLACK) note(-part.left, `#${p.id} ${part.name} runs off the left edge`);
      if (!fit) continue;
      const floor = p.bottom - p.padBottom;
      const ceiling = p.top + (p.padTop ?? 0);
      if (part.bottom > floor + SLACK) note(part.bottom - floor, `#${p.id} ${part.name} ends below the panel`);
      if (part.top < ceiling - SLACK) note(ceiling - part.top, `#${p.id} ${part.name} starts under the top bar`);
      const b = m.band;
      if (b) {
        // How far the part reaches into the band plate, the lesser of the two overlaps.
        const across = Math.min(part.right, b.right) - Math.max(part.left, b.left);
        const down = Math.min(part.bottom, b.bottom) - Math.max(part.top, b.top);
        if (across > SLACK && down > SLACK) note(Math.min(across, down), `#${p.id} ${part.name} runs under the band`);
      }
    }
  }
  return { ok: problems.length === 0, worst, clipped, problems };
}
