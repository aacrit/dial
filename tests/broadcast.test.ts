// T3: the Broadcast, /play/<work>, is the radio on air. Its addresses are
// real pages; its clock, its scrubbing and its meters are pure functions;
// everything it renders from the catalogue or the texts is escaped; the
// analyser stays in the tab; and the contract checks each /play page.

import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKS } from "../web/src/catalogue";
import { detectPerfTier, waveDetail } from "../web/src/device/perf-tier";
import { PEAK_FALL_PER_S, REST_CARRIER, REST_FRAME_MS, meterText, peakHold, waveOffset } from "../web/src/device/wave";
import { segment } from "../web/src/engine/segment";
import { SHORTCUTS, focusKind, keyAction } from "../web/src/player/keys";
import { BAND_DBFS, FLOOR_DBFS, MUSIC_NONE, bandMarks, inBand, loudnessToHeight, registerOf, registerToken, rms, toDbfs } from "../web/src/player/levels";
import {
  SCRUB_BASE_S,
  SCRUB_REPEAT_MS,
  SCRUB_REST,
  estimateLine,
  lineAt,
  lineStarts,
  lineStep,
  madeSeconds,
  runningTime,
  scrubPress,
} from "../web/src/player/timeline";
import { bookplateHeading, ribbonSvg, scriptHtml, shortcutsHtml } from "../web/src/render";
import { pageTitle, parseRoute, playPageHtml, playPath } from "../web/src/route";
import { notMadeYet, scriptNote, stripText } from "../web/src/status-copy";
import { loadContract, runContract } from "../scripts/contract.mjs";
import { shellPaths } from "../scripts/lib/shell.mjs";
import { route as swRoute } from "../web/src/offline/routes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const dist = (rel: string) => path.join(root, "dist", rel);
const main = read("web/src/main.ts");
const EVIL = `"><img src=x onerror=alert(1)>`;

// ---- The addresses ------------------------------------------------------------

describe("each work has its own address, /play/<work>, as a real page", () => {
  it("the build writes dist/play/<slug>.html for every work, titled with the work, from the same entry as /", () => {
    // The gate builds before it tests: a missing page is a failure, not a skip.
    const index = readFileSync(dist("index.html"), "utf8");
    const script = /<script type="module" crossorigin src="(\/assets\/main-[^"]+\.js)"/.exec(index)?.[1];
    expect(script, "index.html's entry script").toBeDefined();
    for (const w of WORKS) {
      const file = dist(`play/${w.slug}.html`);
      expect(existsSync(file), file).toBe(true);
      const html = readFileSync(file, "utf8");
      expect(html).toContain(`<title>${pageTitle(w)}</title>`);
      expect(html).toContain(`<body class="faceplate-page" data-room="broadcast" data-work="${w.slug}">`);
      // The same scripts and styles as the home page, and the same stamped build and policy.
      expect(html).toContain(script!);
      expect(html).toMatch(/<meta name="build" content="[^"_]+"/);
      expect(html).toContain('http-equiv="Content-Security-Policy"');
      // Links that must work from /play/: nothing relative to the page's folder.
      expect(html).not.toMatch(/(href|src)="\.\.?\//);
    }
  });

  it("the offline helper keeps the /play pages with the shell, under their addresses, and answers them as pages", () => {
    const shell = JSON.parse(readFileSync(dist("offline-shell.json"), "utf8")) as string[];
    for (const w of WORKS) expect(shell).toContain(playPath(w.slug));
    expect(shellPaths(["index.html", "play/crito.html"])).toEqual(["/", "/play/crito"]);
    const origin = "https://dial.voidvision.org";
    expect(swRoute(new URL("/play/crito", origin), "GET", origin)).toBe("page");
    expect(swRoute(new URL("/play/crito", origin), "GET", origin, "navigate")).toBe("page");
  });

  it("the path picks the room and the station; an unknown work is the Repertory", () => {
    expect(parseRoute("/", WORKS)).toEqual({ room: "repertory" });
    expect(parseRoute("/play/crito", WORKS)).toEqual({ room: "broadcast", index: 1 });
    expect(parseRoute("/play/meditations/", WORKS)).toEqual({ room: "broadcast", index: 2 });
    expect(parseRoute("/play/cave.html", WORKS)).toEqual({ room: "broadcast", index: 0 });
    expect(parseRoute("/play/phaedo", WORKS)).toEqual({ room: "repertory" });
    expect(parseRoute("/play/../privacy", WORKS)).toEqual({ room: "repertory" });
    expect(playPath("crito")).toBe("/play/crito");
    expect(pageTitle()).toBe("Dial");
    expect(pageTitle(WORKS[1])).toBe("Crito · Dial");
  });

  it("the /play page escapes every catalogue value it writes", () => {
    const index = `<title>Dial</title><meta name="description" content="x" /><body class="faceplate-page">`;
    const html = playPageHtml(index, { slug: EVIL, title: EVIL, credit: EVIL });
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(() => playPageHtml("<html></html>", WORKS[0]!)).toThrow();
  });

  it("Tune in moves to /play/<work> without a reload, the Tune knob keeps the address on the tuned work, and Back returns to the radio", () => {
    expect(main).toMatch(/history\[how === "push" \? "pushState" : "replaceState"\]\(null, "", path\)/);
    expect(main).toMatch(/setRoom\("broadcast", room === "broadcast" \? "replace" : "push"\);/);
    expect(main).toMatch(/if \(room === "broadcast"\) setRoom\("broadcast", "replace"\);/);
    expect(main).toMatch(/addEventListener\("popstate", \(\) => \{[\s\S]*?setRoom\(r\.room, "none"\);/);
    // Nothing navigates the page itself: no location assignment, so the audio never stops.
    expect(main).not.toMatch(/location\.(href|pathname)\s*=|location\.assign|location\.replace/);
    // not_found_handling stays "none" (the pages are real files).
    expect(read("wrangler.jsonc")).toContain('"not_found_handling": "none"');
  });
});

// ---- The clock and scrubbing ----------------------------------------------------

describe("the scrub maths: time to line, and seeks only into what is made", () => {
  const lengths = [2, 3.5, 1, 4];

  it("lines start where the one before ends, speech plus silence", () => {
    expect(lineStarts(lengths)).toEqual([0, 2, 5.5, 6.5]);
    expect(madeSeconds(lengths)).toBe(10.5);
  });

  it("a moment belongs to the last line starting at or before it", () => {
    const starts = lineStarts(lengths);
    expect(lineAt(starts, 0)).toBe(0);
    expect(lineAt(starts, 1.99)).toBe(0);
    expect(lineAt(starts, 2)).toBe(1);
    expect(lineAt(starts, 6)).toBe(2);
    expect(lineAt(starts, 99)).toBe(3);
    expect(lineAt(starts, -5)).toBe(0);
    expect(lineAt([], 1)).toBe(-1);
  });

  it("the 'not made yet' note names what is made, and the page says it only while lines are still being made", () => {
    expect(notMadeYet(40, 252)).toBe("Not made yet. This device has made 40 of 252 lines so far, so it plays from line 40.");
    expect(main).toMatch(/scrubNote\.textContent = target\.beyond && s\.made < s\.cues\.length \? notMadeYet\(s\.made, s\.cues\.length\) : "";/);
    // A seek past the end of a finished work ends the broadcast (the scheduler's complete), with no note.
    expect(main).toMatch(/if \(!target \|\| target\.finished\) return;/);
  });

  it("[ and ] step one line within the lines made, never before the first", () => {
    expect(lineStep(3, 1, 10)).toBe(4);
    expect(lineStep(3, -1, 10)).toBe(2);
    expect(lineStep(0, -1, 10)).toBeNull();
    expect(lineStep(9, 1, 10)).toBeNull();
    expect(lineStep(-1, 1, 10)).toBe(1);
    expect(lineStep(-1, -1, 10)).toBe(0);
    expect(lineStep(2, 1, 0)).toBeNull();
  });

  it("J and L jump 10 s; pressed again quickly the jump doubles to 4x; K or a pause resets it", () => {
    let s = SCRUB_REST;
    const press = (d: -1 | 1, at: number) => {
      const r = scrubPress(s, d, at);
      s = r.next;
      return r.seconds;
    };
    expect(press(1, 1000)).toBe(SCRUB_BASE_S);
    expect(press(1, 1500)).toBe(20);
    expect(press(1, 2000)).toBe(40);
    expect(press(1, 2500)).toBe(40);
    expect(press(1, 2500 + SCRUB_REPEAT_MS + 1)).toBe(10);
    expect(press(-1, 5000)).toBe(-10);
    expect(press(-1, 5100)).toBe(-20);
    s = SCRUB_REST;
    expect(press(-1, 5200)).toBe(-10);
  });

  it("the running time is real for made lines and estimated for the rest, and says 'about' until every line is made", () => {
    const cues = segment(read("web/public/works/crito.txt"));
    const none = runningTime(cues, []);
    expect(none.exact).toBe(false);
    expect(none.seconds / 60).toBeGreaterThan(25);
    expect(runningTime(cues.slice(0, 2), [5, 6])).toEqual({ seconds: 11, exact: true });
    expect(estimateLine({ spoken: "one two three four five", pauseAfterMs: 300 })).toBeCloseTo((5 / 155) * 60 + 0.3);
    expect(stripText(87, 1212, false, 9, 118, 250, false)).toBe("01:27 of about 20:12. Line 9 of 118. Made up to 04:10.");
    expect(stripText(87, 1212, true, 9, 118, 1212, true)).toBe("01:27 of 20:12. Line 9 of 118.");
  });

  it("the page seeks through the scheduler only, whose stop suppresses the end, and reads made lines from the kept lines or the finished file", () => {
    // T5: the seek is marked around the call, so a skip past the end is not a finished listen (tests/recordings.test.ts).
    expect(main).toMatch(/target = s\.sched\.seek\(t\);/);
    expect(main).toMatch(/stop: \(node\) => \{\s*node\.onended = null;\s*node\.stop\(\);/);
    expect(main).toMatch(/if \(own\.wav\) return own\.wav\.chunks\[2 \* i\]/);
    expect(main).toMatch(/own\.file\s*\.slice\(from, from \+ own\.counts\[i\]! \* 2\)\s*\.arrayBuffer\(\)/);
    // The running time is measured when a line is made, never per frame.
    expect(main).toMatch(/sched\.add\(msg\.index, speech, cue\.pauseAfterMs \/ 1000\);[\s\S]*?measureStrip\(own\);/);
    const playhead = /const paintPlayhead = \(\) => \{([\s\S]*?)\n {2}\};/.exec(main)![1]!;
    expect(playhead).not.toMatch(/runningTime\(|liveLine\(/);
    // A released drag lands on the nearest line start.
    expect(main).toMatch(/seekAndSay\(s, nearestLineStart\(/);
    // The media session hears every seek and every line change.
    expect(main).toMatch(/const seekAndSay = [\s\S]*?updatePosition\(s, /);
    expect(main).toMatch(/const lineChanged = [\s\S]*?updatePosition\(s\);/);
    expect(main).toContain("navigator.mediaSession.setPositionState({ duration, position: Math.max(0, Math.min(duration, position)), playbackRate: 1 });");
  });

  it("a locked phone or hidden tab keeps playing from the audio clock: the lookahead rises while hidden; the tick sleeps while paused", () => {
    expect(main).toMatch(/s\.sched\.lookahead = document\.hidden \? HIDDEN_LOOKAHEAD_S : LOOKAHEAD_S;/);
    expect(main).toMatch(/const HIDDEN_LOOKAHEAD_S = 120;/);
    expect(main).toMatch(/if \(audio\.state === "running"\) void sched\.feed\(\);/);
  });

  it("J and L ignore a held key's auto-repeat", () => {
    expect(main).toMatch(/if \(action === "back" \|\| action === "forward"\) \{[\s\S]*?if \(e\.repeat\) return;/);
  });
});

// ---- The keyboard ----------------------------------------------------------------

describe("the keyboard: J/K/L, [ ], Space and ?", () => {
  it("maps the keys, and leaves text fields and modified presses alone", () => {
    expect(keyAction({ key: "j" }, "none")).toBe("back");
    expect(keyAction({ key: "K" }, "none")).toBe("stop");
    expect(keyAction({ key: "l" }, "control")).toBe("forward");
    expect(keyAction({ key: "[" }, "none")).toBe("line-prev");
    expect(keyAction({ key: "]" }, "none")).toBe("line-next");
    expect(keyAction({ key: "?" }, "none")).toBe("shortcuts");
    expect(keyAction({ key: " " }, "none")).toBe("playpause");
    // Space on a button presses the button, not the radio.
    expect(keyAction({ key: " " }, "control")).toBeNull();
    expect(keyAction({ key: "j" }, "text")).toBeNull();
    expect(keyAction({ key: "l", ctrlKey: true }, "none")).toBeNull();
    expect(keyAction({ key: "x" }, "none")).toBeNull();
  });

  it("knows a text field from a control", () => {
    expect(focusKind(null)).toBe("none");
    expect(focusKind({ tagName: "TEXTAREA" })).toBe("text");
    expect(focusKind({ tagName: "INPUT", type: "text" })).toBe("text");
    expect(focusKind({ tagName: "INPUT", type: "checkbox" })).toBe("control");
    expect(focusKind({ tagName: "BUTTON" })).toBe("control");
    expect(focusKind({ tagName: "svg", role: "slider" })).toBe("control");
    expect(focusKind({ tagName: "DIV", isContentEditable: true })).toBe("text");
    expect(focusKind({ tagName: "BODY" })).toBe("none");
  });

  it("the shortcuts sheet lists exactly the keys this page answers, from design/spec.md 1.6, escaped", () => {
    const spec = read("design/spec.md");
    for (const [, what] of SHORTCUTS.slice(0, 4)) expect(spec).toContain(what.replace(/\.$/, ""));
    // "/" (search) is not offered, because there is no search yet.
    expect(SHORTCUTS.flatMap(([k]) => k)).not.toContain("/");
    const html = shortcutsHtml([[[EVIL], EVIL]]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

// ---- Meters and the wave -----------------------------------------------------------

describe("the analyser-to-meter mapping (pure)", () => {
  it("loudness: RMS to dBFS to the meter's height, floored at -40", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms([])).toBe(0);
    expect(toDbfs(1)).toBe(0);
    expect(toDbfs(0.1)).toBeCloseTo(-20);
    expect(toDbfs(0)).toBe(FLOOR_DBFS);
    expect(toDbfs(1e-9)).toBe(FLOOR_DBFS);
    expect(loudnessToHeight(0)).toBe(1);
    expect(loudnessToHeight(-40)).toBe(0);
    expect(loudnessToHeight(-20)).toBe(0.5);
    expect(loudnessToHeight(-90)).toBe(0);
  });

  it("the in-range band is -23 to -18 dBFS, and style.css draws it where the maths puts it", () => {
    expect(BAND_DBFS).toEqual([-23, -18]);
    expect(inBand(-20)).toBe(true);
    expect(inBand(-25)).toBe(false);
    const [a, b] = bandMarks();
    const css = read("web/src/style.css");
    expect(css).toContain(`left: ${(a * 100).toFixed(1)}%;`);
    expect(css).toContain(`width: ${((b - a) * 100).toFixed(1)}%;`);
  });

  it("register: a line with a speaker is speaking, any other is telling; each hue is a token", () => {
    expect(registerOf({ speaker: "SOCRATES" })).toBe("speaking");
    expect(registerOf({})).toBe("telling");
    expect(registerOf(undefined)).toBe("telling");
    const tokens = read("design/tokens.css");
    for (const r of ["telling", "speaking", "letter"] as const) expect(tokens).toContain(`${registerToken(r)}:`);
    // Letter and verse are reserved for F1: nothing gives a line that register yet.
    const crito = segment(read("web/public/works/crito.txt"));
    expect(new Set(crito.map(registerOf))).toEqual(new Set(["speaking"]));
  });

  it("Music rests at zero and says so, truthfully: no motion is faked", () => {
    expect(MUSIC_NONE).toBe("Music: none in this work yet");
    expect(read("web/index.html")).toContain(`<span class="il" id="m-music">${MUSIC_NONE}</span>`);
    expect(read("web/index.html")).toContain('<i class="rest"></i>');
    // Nothing drives the Music bar: neither the loop nor the page touches it.
    for (const f of ["web/src/device/wave.ts", "web/src/main.ts"]) expect(read(f), f).not.toMatch(/musicBar|m-music|\.rest|"rest"/);
  });

  it("the wave: a faint carrier at rest, hiss off station, a clean line on station, flat in a silence", () => {
    // Flat: exactly the baseline during a silence cue.
    for (const u of [0.1, 0.5, 0.9]) expect(waveOffset(u, 3, 0.8, 1, 0, 0.5, true)).toBe(0);
    // The edges are pinned by the sin(pi x) envelope.
    expect(Math.abs(waveOffset(0, 2, 1, 0, 0, 0, false))).toBeLessThan(1e-9);
    // Off station the ghost lines drift from the carrier; on station they converge onto it.
    const spread = (align: number) => Math.abs(waveOffset(0.37, 2, 0, align, 2, 0, false) - waveOffset(0.37, 2, 0, align, 0, 0, false));
    expect(spread(1)).toBeLessThan(spread(0));
    expect(spread(1)).toBeCloseTo(0);
    // The live voice moves the carrier on station, and not off it.
    expect(waveOffset(0.5, 2, 0.5, 1, 0, 0.6, false)).not.toBeCloseTo(waveOffset(0.5, 2, 0.5, 1, 0, 0, false));
    expect(waveOffset(0.5, 2, 0.5, 0, 0, 0.6, false)).toBeCloseTo(waveOffset(0.5, 2, 0.5, 0, 0, 0, false));
    expect(REST_CARRIER).toBe(0.16);
  });

  it("the wave's loop allocates nothing per frame, caps the pixel ratio at 2, and reads colours from the tokens", () => {
    const wave = read("web/src/device/wave.ts");
    expect(wave).toContain("Math.min(2, window.devicePixelRatio || 1)");
    const tick = /const tick = \(ms: number\) => \{([\s\S]*?)\n {2}\};/.exec(wave)![1]!;
    const draw = /const draw = \(level: number, align: number\) => \{([\s\S]*?)\n {2}\};/.exec(wave)![1]!;
    for (const body of [tick, draw]) expect(body).not.toMatch(/new |\[\]|\{\s*\}|\.map\(|\.slice\(/);
    // One sample buffer, made only when a new analyser arrives.
    expect(wave).toMatch(/if \(samplesFor !== a\) \{\s*samples = new Float32Array\(a\.fftSize\);/);
    expect(wave).not.toMatch(/rgba?\(|#[0-9a-f]{3,6}\b/i);
    expect(wave).toContain('tokenColour(host, "--color-glass-amber")');
  });

  it("the wave sleeps: off screen it stops, at rest it draws about 20 times a second, and the low tier draws no glow", () => {
    const wave = read("web/src/device/wave.ts");
    expect(wave).toContain("new IntersectionObserver(");
    expect(wave).toMatch(/if \(!onScreen\) \{[\s\S]*?return;/);
    expect(REST_FRAME_MS).toBe(50);
    // At rest the loop sleeps on a timer (not polling frames); playing wakes it at once.
    expect(wave).toMatch(/if \(air\.playing\) frame = requestAnimationFrame\(tick\);\s*else rest = window\.setTimeout\(restWake, REST_FRAME_MS\);/);
    expect(wave).toMatch(/function wake\(\) \{[\s\S]*?clearTimeout\(rest\);/);
    expect(wave).toContain("ctx.shadowBlur = detail.ghosts ? 8 : 0;");
  });

  it("the Voice meter is a meter for assistive tech, its value following the level a few times a second", () => {
    const html = read("web/index.html");
    expect(html).toContain('id="m-voice-meter" role="meter" aria-label="Voice loudness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"');
    const wave = read("web/src/device/wave.ts");
    expect(wave).toMatch(/if \(voiceMeter && pct !== meterSaid && now - meterSaidAt >= 250\) \{[\s\S]*?voiceMeter\.setAttribute\("aria-valuenow", String\(pct\)\);/);
    expect(meterText(0)).toBe("Silent");
    expect(meterText(42)).toBe("42 percent");
  });

  it("the meter's peak hold jumps up at once and falls back slowly", () => {
    expect(peakHold(0.2, 0.6, 0.016)).toBe(0.6);
    expect(peakHold(0.6, 0.2, 1)).toBeCloseTo(0.6 - PEAK_FALL_PER_S);
    expect(peakHold(0.1, 0, 10)).toBe(0);
  });

  it("the perf tier only thins the drawing", () => {
    expect(detectPerfTier({ deviceMemory: 2 })).toBe("low");
    expect(detectPerfTier({ hardwareConcurrency: 4 })).toBe("low");
    expect(detectPerfTier({ hardwareConcurrency: 8, deviceMemory: 8, userAgent: "Mozilla/5.0 (Linux; Android 14)" })).toBe("standard");
    expect(detectPerfTier({ userAgent: "Mozilla/5.0 (Linux; Android 9)" })).toBe("low");
    expect(detectPerfTier(undefined)).toBe("standard");
    expect(waveDetail("low")).toEqual({ step: 6, ghosts: false });
    expect(waveDetail("standard")).toEqual({ step: 3, ghosts: true });
    // Never a speed estimate: the render path does not read it.
    expect(read("web/src/narrate.worker.ts")).not.toMatch(/perf-tier|PerfTier/);
  });
});

// ---- Reduced motion -------------------------------------------------------------------

describe("reduced motion: everything snaps", () => {
  it("the wave is drawn once and holds still; the meter snaps; the eye and the needle snap with every spring", () => {
    const wave = read("web/src/device/wave.ts");
    const tick = /const tick = \(ms: number\) => \{([\s\S]*?)\n {2}\};/.exec(wave)![1]!;
    // The clock only runs without reduced motion; with it, draw(0, …) holds the wave still.
    expect(tick).toMatch(/if \(!reduce\) \{\s*t \+= dt;/);
    expect(tick).toContain("draw(0, align);");
    expect(tick).toContain("paintMeter(L, ");
    // design/spec.md 1.4: with reduced motion the eye is drawn closed, warming or not.
    expect(read("web/src/device/radio.ts")).toContain("eye.to(eyeWedge(motion.reduce ? 1 : alignment(angles, needle.x) * ready)).step(dt, motion.reduce);");
  });

  it("the script scrolls to the live line without smooth scrolling, only inside its widget, and the sheets' entrance collapses", () => {
    // T8: the script is a widget on the work panel; its scroller moves, never the panels (no scrollIntoView, which would jump the page).
    const panels = read("web/src/panels-ui.ts");
    expect(panels).toContain('scroller.scrollTo({ top: Math.max(0, top), behavior: motion.reduce ? "auto" : "smooth" });');
    expect(panels).toContain('behavior: instant || motion.reduce ? "auto" : "smooth"');
    expect(main).toContain("centreWithin(scriptPanel, el)");
    for (const [f, src] of [["main.ts", main], ["panels-ui.ts", panels]]) expect(src, f).not.toMatch(/scrollIntoView/);
    expect(read("design/tokens.css")).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.001ms !important;/);
    expect(read("web/src/style.css")).toMatch(/dialog\.sheet\[open\] \{\s*animation: sheet-rise var\(--dur-morph\)/);
  });
});

// ---- Escaping ---------------------------------------------------------------------------

describe("everything rendered from the texts or the catalogue is escaped", () => {
  it("the full script: escaped, the live line marked, lines not made yet disabled, one tab stop", () => {
    const source = `${EVIL} Second.

Third.`;
    const cues = [
      { start: 0, end: EVIL.length, text: EVIL },
      { start: EVIL.length + 1, end: EVIL.length + 8, text: "Second." },
      { start: EVIL.length + 10, end: EVIL.length + 16, text: "Third." },
    ];
    const html = scriptHtml(source, cues, 1, 2);
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).toContain('<span class="sl live" role="button" tabindex="0" data-i="1" aria-current="true">Second.</span></p>\n\n<p>');
    expect(html).toContain('<span class="sl unmade" role="button" tabindex="-1" data-i="2" aria-disabled="true">Third.</span>');
    expect([...html.matchAll(/tabindex="0"/g)].length).toBe(1);
    // Nothing between lines the source runs together.
    expect(scriptHtml("ab", [{ start: 0, end: 1, text: "a" }, { start: 1, end: 2, text: "b" }], -1, 0)).toMatch(/>a<\/span><span/);
    expect(main).toMatch(/const to = \{ ArrowDown: i \+ 1, ArrowRight: i \+ 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: all\.length - 1 \}\[e\.key\];/);
  });

  it("the full script is verbatim: for every work, its text with whitespace collapsed is the source's", () => {
    // textContent as a browser computes it: tags removed (never replaced by a space), entities decoded.
    const unescape = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const collapse = (t: string) => t.replace(/\s+/g, " ").trim();
    for (const w of WORKS) {
      const src = read(`web/public/works/${w.slug}.txt`);
      const sheet = collapse(unescape(scriptHtml(src, segment(src), -1, 0)));
      expect(sheet, w.slug).toBe(collapse(src));
      // Speaker labels are printed as the source prints them ("SOCRATES:"), never as the read-along's derived names.
      for (const label of ["SOCRATES:", "CRITO:"]) expect(sheet.split(label).length, `${w.slug} ${label}`).toBe(src.split(label).length);
    }
    // Crito has labels to keep: 95 of them.
    const crito = read("web/public/works/crito.txt");
    expect((crito.match(/\b(SOCRATES|CRITO):/g) ?? []).length).toBe(95);
    // The page gives the sheet the verbatim cues and the source, never the read-along's lines (readLines drops the label).
    expect(main).toContain("scriptHtml(text.source, text.cues, s ? s.line : -1, s ? s.made : 0)");
    expect(/scriptHtml\([^)]*readLines/.test(main)).toBe(false);
  });

  it("the strip draws numbers only; the Bookplate heading and the notes are set as text", () => {
    const svg = ribbonSvg([1, 2, 3], 6, 2, 0);
    expect([...svg.matchAll(/class="([^"]*)"/g)].map((m) => m[1])).toEqual(["seg", "seg ahead", "seg unmade"]);
    expect(svg).not.toMatch(/\sstyle=/);
    expect(bookplateHeading(WORKS[1]!)).toBe("514 · No. 002 · Crito");
    expect(main).toContain("bpNote.textContent = bookplateHeading(w);");
    expect(main).toContain("scriptNoteEl.textContent = scriptNote(w.translator, !!s);");
    expect(scriptNote("George Long", true)).toBe("Long's words, exactly as printed. Choose a line to play from it.");
    expect(scriptNote("Benjamin Jowett", false)).toBe("Jowett's words, exactly as printed. Tune in to play from a line.");
  });
});

// ---- Law 1 and privacy ----------------------------------------------------------------------

describe("Law 1: the analyser is local and T3 adds no request", () => {
  const files = ["web/src/player/scheduler.ts", "web/src/device/wave.ts", "web/src/device/perf-tier.ts", "web/src/player/levels.ts", "web/src/player/timeline.ts", "web/src/player/keys.ts", "web/src/player/sheets.ts", "web/src/route.ts"];

  it("the Broadcast's own modules make no request and post nothing", () => {
    for (const f of files) expect(read(f), f).not.toMatch(/fetch\(|postMessage|sendBeacon|XMLHttpRequest|WebSocket|getUserMedia|localStorage|indexedDB/);
  });

  it("the page's requests are still only the works' texts and /feedback (with /e in telemetry.ts); a made line is read back from the file in memory", () => {
    const calls = [...main.matchAll(/\bfetch\(\s*([^,)]+)/g)].map((m) => m[1]!.trim());
    // /e moved to telemetry.ts with T6; the page itself fetches only the works' texts and feedback.
    expect(calls).toEqual(["`/works/${w.slug}.txt`", '"/feedback"']);
    // The analyser hangs off the broadcast's own context, before the Volume knob's gain (it reads the voice, not the volume).
    expect(main).toMatch(/const analyser = audio\.createAnalyser\(\);\s*analyser\.fftSize = 2048;\s*analyser\.connect\(gain\);\s*gain\.connect\(audio\.destination\);/);
    expect(main).toMatch(/node\.connect\(analyser\);/);
    expect([...main.matchAll(/createAnalyser\(/g)].length).toBe(1);
    expect(main).not.toMatch(/createMediaStreamDestination|captureStream|MediaRecorder/);
  });
});

// ---- The contract -----------------------------------------------------------------------------

describe("the contract checks each /play page", () => {
  let server: Server;
  let baseUrl = "";

  // Serves dist/ the way Workers Static Assets does for these pages: /play/<slug> answers with play/<slug>.html.
  beforeAll(async () => {
    server = createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      const file = p === "/" ? "index.html" : p.startsWith("/play/") ? `${p.slice(1)}.html` : p.slice(1);
      try {
        const body = readFileSync(dist(file));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const a = server.address();
    if (a && typeof a === "object") baseUrl = `http://127.0.0.1:${a.port}`;
  });
  afterAll(() => server.close());

  it("contract.yaml has a 200 and a title check for every work's /play page, and they pass on the build", async () => {
    const contract = loadContract(path.join(root, "contract.yaml")) as { checks: { path?: string; type: string; text?: string; expect?: number }[] };
    const play = contract.checks.filter((c) => c.path?.startsWith("/play/"));
    for (const w of WORKS) {
      expect(play.some((c) => c.path === playPath(w.slug) && c.type === "status" && c.expect === 200), w.slug).toBe(true);
      expect(play.some((c) => c.path === playPath(w.slug) && c.type === "contains" && c.text === `<title>${pageTitle(w)}</title>`), w.slug).toBe(true);
    }
    const results = (await runContract({ checks: play }, baseUrl)) as { pass: boolean; label: string; detail?: string }[];
    expect(results.filter((r) => !r.pass)).toEqual([]);
    expect(results.length).toBe(play.length);
  });
});
