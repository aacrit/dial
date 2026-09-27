// T2: the radio at `/` tunes between three works. The catalogue's printed
// claims, the needle's physics, the escaping of everything the page
// interpolates, and the work_opened plumbing with its share of the account's
// D1 writes.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { WORKS, aboutMinutes, countWords, grouped, isPublicDomainWorldwide } from "../web/src/catalogue";
import { firstOpen, lampLit, liveLine, wavName } from "../web/src/broadcast-state";
import { ALIGN_WIDTH_DEG, MAX_ANGLE, alignment, angleAt, eyeWedge, landing, nearestStation, polar, tickStep } from "../web/src/device/needle";
import { PRESETS, Spring, parseSpring } from "../web/src/device/spring";
import { cast } from "../web/src/engine/cast";
import { segment } from "../web/src/engine/segment";
import { bookplateHtml, esc, metaHtml, presetKeysHtml, readAlongHtml, scaleSvg } from "../web/src/render";
import { ACCOUNT_D1_WRITES_PER_DAY, ALLOWED_EVENTS, CLIENT_EVENTS, DEFAULT_EVENT_DAILY_CEILING, worstCaseDailyWrites } from "../worker/src/config";
import { madeHere, progressLine, switchQuestion } from "../web/src/status-copy";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const text = (slug: string) => read(`web/public/works/${slug}.txt`);
const main = read("web/src/main.ts");

// ---- The catalogue ------------------------------------------------------------

describe("the catalogue: three stations, every printed claim true", () => {
  it("holds the three works in station order, each with a text on disk", () => {
    expect(WORKS.map((w) => [w.station, w.slug])).toEqual([
      ["001", "cave"],
      ["002", "crito"],
      ["003", "meditations"],
    ]);
    for (const w of WORKS) expect(text(w.slug).length, w.slug).toBeGreaterThan(1000);
  });

  it("cites the Gutenberg eBook each text was cut from, and the passage's first and last words are in the text", () => {
    expect(WORKS.map((w) => w.source.ebook)).toEqual([1497, 1657, 15877]);
    for (const w of WORKS) {
      const t = text(w.slug).replace(/\s+/g, " ");
      expect(t, w.slug).toContain(w.source.from);
      expect(t.trimEnd().endsWith(w.source.to), w.slug).toBe(true);
    }
  });

  it("states the real translator and death years, and each work is public domain worldwide by the Repertory's rule", () => {
    // Wikipedia, checked 2026-09-26: Benjamin Jowett died 1 October 1893 (Dialogues
    // of Plato, 1871); George Long died 10 August 1879 (Meditations, 1862).
    expect(WORKS.map((w) => [w.translator, w.pd.published, w.pd.translatorDied])).toEqual([
      ["Benjamin Jowett", 1871, 1893],
      ["Benjamin Jowett", 1871, 1893],
      ["George Long", 1862, 1879],
    ]);
    for (const w of WORKS) expect(isPublicDomainWorldwide(w), w.slug).toBe(true);
    expect(isPublicDomainWorldwide({ pd: { published: 1925, translatorDied: 1960, publishedAs: "Published" } })).toBe(false);
    expect(isPublicDomainWorldwide({ pd: { published: 1931, translatorDied: 1900, publishedAs: "Published" } })).toBe(false);
  });

  it("a work says it plays at once only where its prepared recording opened; the catalogue types no such claim (T5)", () => {
    for (const w of WORKS) expect(w, w.slug).not.toHaveProperty("preparedRecording");
    expect(main).toMatch(/const hasRecording = !!text\?\.cast && prepared\.has\(w\.slug\);/);
    expect(main).toMatch(/if \(opened\.recording\) prepared\.set\(w\.slug, opened\.recording\);/);
    for (const kept of [true, false]) {
      expect(madeHere(kept)).toMatch(/^Made on your device as you listen/);
      expect(madeHere(kept)).not.toMatch(/in advance|at once/);
    }
    // Once the voice could not be kept, the page stops saying it is kept.
    expect(madeHere(true)).toContain("then is kept on this device");
    expect(madeHere(false)).not.toMatch(/is kept/);
    expect(main).toMatch(/voiceKept = msg\.kept;\s*paintAvail\(\);/);
    expect(main).toMatch(/avail\.textContent = text && !text\.cast \? CAST_FAILED : hasRecording \? PLAYS_AT_ONCE : madeHere\(voiceKept\);/);
  });

  it("computes word counts from the text, never types them (they match the spec's checked counts)", () => {
    expect(WORKS.map((w) => countWords(text(w.slug)))).toEqual([2990, 5347, 2350]);
    expect(grouped(2990)).toBe("2,990");
    for (const w of WORKS) expect(JSON.stringify(w)).not.toMatch(/2,?990|5,?347|2,?350/);
  });

  it("estimates running time from the words at 155 a minute plus the pause table", () => {
    const minutes = WORKS.map((w) => aboutMinutes(text(w.slug), segment(text(w.slug))));
    // The spec quotes about 20, 36 and 16 min for these texts.
    expect(minutes).toEqual([20, 36, 16]);
    expect(aboutMinutes("one two", [])).toBe(1);
  });

  it("the catalogue text states the voices the render really uses (tests/speakers.test.ts has the cast)", () => {
    const voices = WORKS.map((w) => metaHtml(w, 10, cast(segment(text(w.slug)))));
    expect(voices.map((m) => /<span>(\w+ voices?)<\/span>/.exec(m)?.[1])).toEqual(["One voice", "Two voices", "One voice"]);
    expect(bookplateHtml(WORKS[0]!, cast(segment(text("cave"))))).toContain("One voice, Michael, reads every part.");
    expect(read("web/src/narrate.worker.ts")).toMatch(/tts\.generate\(cues\[i\]!\.spoken, \{ voice \}\)/);
  });
});

// ---- The needle ------------------------------------------------------------------

describe("the needle's spring physics", () => {
  const swing = (from: number, to: number, dt = 1 / 60, seconds = 3) => {
    const s = new Spring(PRESETS.swing, from).to(to);
    let peak = from;
    let settledAt = 0;
    for (let t = dt; t <= seconds + 1e-9; t += dt) {
      s.step(dt);
      peak = to > from ? Math.max(peak, s.x) : Math.min(peak, s.x);
      if (Math.abs(s.x - to) > 0.5) settledAt = t;
    }
    return { s, overshoot: Math.abs(peak - to) / Math.abs(to - from), settledAt };
  };

  it("settles on the station: 001 to 003 is within half a degree in about 0.9 s and at rest by 3 s", () => {
    const { s, settledAt } = swing(-44, 26);
    expect(settledAt).toBeLessThan(1.2);
    expect(s.resting).toBe(true);
    expect(s.x).toBeCloseTo(26, 3);
  });

  it("overshoots like a weighted needle: about 30%, bounded between 20% and 35% on every hop", () => {
    for (const [a, b] of [[-44, -8], [-8, 26], [-44, 26], [26, -44]] as const) {
      const { overshoot } = swing(a, b);
      expect(overshoot, `${a} to ${b}`).toBeGreaterThan(0.2);
      expect(overshoot, `${a} to ${b}`).toBeLessThan(0.35);
    }
  });

  it("is frame-rate independent: 30, 60 and 150 fps land within a quarter of a degree of each other, mid-swing", () => {
    const at = (fps: number) => {
      const s = new Spring(PRESETS.swing, -44).to(26);
      for (let i = 0; i < Math.round(0.4 * fps); i++) s.step(1 / fps);
      return s.x;
    };
    expect(Math.abs(at(30) - at(150))).toBeLessThan(0.25);
    expect(Math.abs(at(60) - at(150))).toBeLessThan(0.25);
  });

  it("reduced motion snaps: one step lands on the target with no speed and no overshoot", () => {
    const s = new Spring(PRESETS.swing, -44).to(26);
    s.step(1 / 60, true);
    expect(s.x).toBe(26);
    expect(s.v).toBe(0);
    expect(s.resting).toBe(true);
  });

  it("the presets are the token file's numbers", () => {
    const tokens = read("design/tokens.css");
    const token = (name: string) => parseSpring(new RegExp(`--spring-${name}:\\s*([^;]+);`).exec(tokens)?.[1], [0, 0, 0]);
    expect(token("needle-swing")).toEqual(PRESETS.swing);
    expect(token("needle-drop")).toEqual(PRESETS.drop);
    expect(token("valve-warm")).toEqual(PRESETS.warm);
    expect(token("vu")).toEqual(PRESETS.vu);
    expect(token("follow")).toEqual(PRESETS.follow);
    expect(parseSpring("oops", PRESETS.swing)).toEqual(PRESETS.swing);
    expect(parseSpring("1 -2 3", PRESETS.swing)).toEqual(PRESETS.swing);
  });

  const angles = WORKS.map((w) => w.angle);

  it("a released needle keeps its speed: the landing is projected 0.16 s ahead, then snaps to the nearest station", () => {
    expect(landing(angles, -30, 0)).toBe(0);
    expect(landing(angles, -30, 150)).toBe(1); // -30 + 24 = -6: Crito
    expect(landing(angles, -30, 400)).toBe(2); // flung past Crito to the Meditations
    expect(landing(angles, 60, 0)).toBe(2);
    expect(landing(angles, 0, -9999)).toBe(0); // clamped to the scale's end
    expect(nearestStation(angles, 9)).toBe(1);
    expect(nearestStation(angles, 10)).toBe(2);
  });

  it("the eye closes on a station and opens between them", () => {
    expect(alignment(angles, -8)).toBe(1);
    expect(alignment(angles, -8 + ALIGN_WIDTH_DEG)).toBe(0);
    expect(eyeWedge(1)).toBeLessThan(eyeWedge(0));
  });

  it("the dial's geometry: stations inside the 136-degree scale, pointer angles clamped, ticks by width", () => {
    for (const w of WORKS) expect(Math.abs(w.angle)).toBeLessThan(MAX_ANGLE);
    const [x, y] = polar(26, 100);
    expect(angleAt(x, y)).toBeCloseTo(26, 6);
    expect(angleAt(400, 236)).toBe(MAX_ANGLE);
    expect([tickStep(375), tickStep(700), tickStep(1000)]).toEqual([2.5, 2, 1]);
  });
});

// ---- Escaping --------------------------------------------------------------------

describe("every renderer escapes what it interpolates, attributes included", () => {
  const XSS = `"><img src=x onerror=alert(1)>`;
  const hostile = {
    ...WORKS[0]!,
    station: XSS,
    dial: XSS,
    title: XSS,
    short: XSS,
    translator: XSS,
    librivox: XSS,
    source: { ebook: XSS as unknown as number, book: XSS, from: XSS, to: XSS, notPerformed: XSS },
    pd: { published: 1871, translatorDied: 1893, publishedAs: XSS as "Published" },
  };
  const outputs = {
    esc: esc(XSS),
    bookplate: bookplateHtml(hostile),
    scale: scaleSvg([hostile], 2, 0),
    keys: presetKeysHtml([hostile], 0),
    readAlong: readAlongHtml([{ text: XSS }, { text: XSS, speaker: XSS }, { text: XSS }], 1),
  };

  for (const [name, html] of Object.entries(outputs)) {
    it(`${name}: no tag or attribute breaks out`, () => {
      expect(html).not.toContain("<img");
      expect(html).not.toMatch(/"\s*>\s*<img|onerror=alert\(1\)>/);
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html).not.toMatch(/\sstyle=/);
    });
  }

  it("a quote cannot end an attribute: the preset key's label stays one attribute", () => {
    const keys = presetKeysHtml([hostile], 0);
    expect(keys).toContain('aria-label="&quot;&gt;&lt;img');
  });
});

// ---- work_opened ----------------------------------------------------------------

describe("work_opened: once per station per page load, within the ceilings' share", () => {
  it("is an allowed client event in contract.yaml and the Worker", () => {
    const contract = parseYaml(read("contract.yaml"));
    expect(contract.events.allowed).toContain("work_opened");
    expect(contract.events.server_only).not.toContain("work_opened");
    expect(ALLOWED_EVENTS as readonly string[]).toContain("work_opened");
    expect(CLIENT_EVENTS).toEqual(["page_view", "work_opened", "chapter_rendered"]);
  });

  it("firstOpen is true once per slug and false after", () => {
    const opened = new Set<string>();
    expect(firstOpen(opened, "crito")).toBe(true);
    expect(firstOpen(opened, "crito")).toBe(false);
    expect(firstOpen(opened, "cave")).toBe(true);
    expect(firstOpen(opened, "crito")).toBe(false);
    expect([...opened]).toEqual(["crito", "cave"]);
  });

  it("the page sends it only when Tune in starts a work, through firstOpen; tuning and browsing send nothing (founder, 2026-09-26)", () => {
    expect([...main.matchAll(/sendEvent\("work_opened"\)/g)].length).toBe(1);
    const start = /const start = \(work: Work, kind: ListenKind, opts[^\n]*\) => \{([\s\S]*?)\n {2}\};/.exec(main)?.[1];
    // A work that could not be cast (or a prepared recording that is not there) cannot start, so it is never counted as opened.
    expect(start).toMatch(
      /^\s*const text = [^\n]*\n\s*const cast = text\.cast;\n\s*if \(!cast\) return;\n\s*const rec = [^\n]*\n\s*if \(kind === "prepared" && !rec\) return;\n\s*\/\/[^\n]*\n\s*if \(firstOpen\(opened, work\.slug\)\) sendEvent\("work_opened"\);/,
    );
    const onTune = /onTune: \(\) => \{([\s\S]*?)\n {4}\},/.exec(main)?.[1];
    expect(onTune).toBeDefined();
    expect(onTune).not.toMatch(/sendEvent|firstOpen|start\(/);
    expect(read("design/spec.md")).toContain("Events: `work_opened` fires when Tune in is pressed on a work, once per work per page load");
  });

  it("the ceiling math: three client events at 3,500 a day stay within 15% of the account, and budget.yaml says so", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toContain('"EVENT_DAILY_CEILING": "3500"');
    expect(DEFAULT_EVENT_DAILY_CEILING).toBe(3500);
    const { total, lines } = worstCaseDailyWrites({ event: 3500, feedback: 100 });
    expect(lines[0]).toEqual({ what: "/e client events", rows: 3 * (3501 + 400) });
    expect(total).toBe(14105);
    expect(total).toBeLessThanOrEqual(0.15 * ACCOUNT_D1_WRITES_PER_DAY);
    // At the old 4,000 the third event would have broken the share.
    expect(worstCaseDailyWrites({ event: 4000, feedback: 100 }).total).toBeGreaterThan(0.15 * ACCOUNT_D1_WRITES_PER_DAY);
    const budget = read("budget.yaml");
    expect(budget).toContain("worst_case_rows: 14105");
    expect(budget).toContain("3 x (3,500 + 1 + a daily feedback purge");
  });

  it("the privacy page's counts claim names a work chosen on the dial", () => {
    const privacy = read("web/privacy.html").replace(/\s+/g, " ");
    expect(privacy).toContain("counts how many times a small set of named events happen each day, such as a page view, a work chosen on the dial, or a completed action, as totals");
  });
});

// ---- The broadcast's small rules ---------------------------------------------------

describe("the broadcast's rules", () => {
  it("the live line is the last one whose start has passed", () => {
    expect(liveLine([], 5)).toBe(-1);
    expect(liveLine([1, 2, 3], 0.5)).toBe(-1);
    expect(liveLine([1, 2, 3], 2.5)).toBe(1);
    expect(liveLine([1, 2, undefined], 9)).toBe(1);
  });

  it("the lamp stays lit while lines are still being made, even paused", () => {
    expect(lampLit({ live: true, playing: false, renderDone: false })).toBe(true);
  });

  it("the download is named for the station and the work, and its label says which work it is", () => {
    expect(wavName("002", "Crito")).toBe("dial-514-002-crito.wav");
    expect(wavName("003", "Meditations, Book II")).toBe("dial-514-003-meditations-book-ii.wav");
    expect(read("web/index.html")).toContain(">Download as an audio file</a>");
    expect(main).toContain("download.textContent = `Download ${work.called} as an audio file`;");
  });

  it("one object URL at a time, and the previous finished file stays until the new one is made", () => {
    expect(main).toMatch(/if \(downloadUrl\) URL\.revokeObjectURL\(downloadUrl\);\s*own\.file = own\.wav \? new Blob\([^\n]*\n\s*\/\/[^\n]*\n\s*downloadUrl = own\.file && !seeded\.length \? URL\.createObjectURL\(own\.file\) : null;/);
    const start = /const start = \(work: Work, kind: ListenKind, opts[^\n]*\) => \{([\s\S]*?)\n {2}\};/.exec(main)![1]!;
    const beforeDone = start.slice(0, start.indexOf('msg.type === "done"'));
    expect(beforeDone).not.toMatch(/revokeObjectURL|download\.hidden = true|removeAttribute\("href"\)/);
  });
});
