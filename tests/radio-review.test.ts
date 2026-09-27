// T2 review round: the download without a whole-work copy, focus that never
// sits on a hidden control, a live region that announces state changes only,
// the question before a broadcast is stopped, pointer capture, and the small
// copy fixes.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKS } from "../web/src/catalogue";
import { cast } from "../web/src/engine/cast";
import { segment } from "../web/src/engine/segment";
import { capture } from "../web/src/device/radio";
import { WavChunks, assemble, encodeWav, wavHeader } from "../web/src/engine/wav";
import { bookplateHtml } from "../web/src/render";
import { progressLine, switchQuestion } from "../web/src/status-copy";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const text = (slug: string) => read(`web/public/works/${slug}.txt`);
const main = read("web/src/main.ts");
const radioSrc = read("web/src/device/radio.ts");
const block = (src: string, head: string, indent = 2) => {
  const at = src.indexOf(head);
  if (at < 0) return undefined;
  const end = src.indexOf(`\n${" ".repeat(indent)}};`, at);
  return src.slice(at, end);
};

describe("the download is built from 16-bit chunks, never a whole-work Float32 copy", () => {
  const lines = [
    { audio: new Float32Array([0.5, -0.5, 1.2, -1.3, 0.25]), pauseAfterMs: 300 },
    { audio: new Float32Array([0.1, -0.999, 0]), pauseAfterMs: 0 },
    { audio: new Float32Array([0.75]), pauseAfterMs: 4500 },
  ];
  const bytesOf = async (parts: BlobPart[]) => new Uint8Array(await new Blob(parts).arrayBuffer());

  it("gives the same file, byte for byte, as the old assemble-then-encode path", async () => {
    const chunks = new WavChunks(24_000);
    for (const l of lines) chunks.add(l.audio, l.pauseAfterMs);
    expect(await bytesOf(chunks.parts())).toEqual(encodeWav(assemble(lines, 24_000), 24_000));
  });

  it("writes the header sizes for the data it holds", async () => {
    const chunks = new WavChunks(10);
    chunks.add(new Float32Array([0.5, -0.5]), 1000);
    expect(chunks.dataBytes).toBe(24);
    const wav = await bytesOf(chunks.parts());
    const v = new DataView(wav.buffer);
    expect(wav.length).toBe(44 + 24);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 24);
    expect(v.getUint32(24, true)).toBe(10);
    expect(v.getUint32(28, true)).toBe(20);
    expect(v.getUint32(40, true)).toBe(24);
    expect(v.getInt16(44, true)).toBe(16383);
    expect(v.getInt16(46, true)).toBe(-0x4000);
    expect(v.getInt16(48, true)).toBe(0);
    expect(wavHeader(24, 10)).toEqual(wav.slice(0, 44));
  });

  it("the page keeps no Float32 copy or whole-work buffer, and lets go of the chunks and the worker's handlers", () => {
    expect(main).not.toMatch(/assemble\(|encodeWav\(|rendered\.push/);
    expect(main).toContain("own.wav.add(msg.audio, cue.pauseAfterMs);");
    expect(main).toMatch(/new Blob\(own\.wav\.parts\(\), \{ type: "audio\/wav" \}\)[\s\S]*?own\.wav = null;/);
    const offAir = block(main, "const offAir = () => {")!;
    for (const release of ["s.worker.onmessage = null", "s.worker.onerror = null", "s.audio.onstatechange = null", "s.wav = null"]) {
      expect(offAir).toContain(release);
    }
    expect(main).toMatch(/msg\.type === "done"\) \{\s*worker\.onmessage = null;\s*worker\.onerror = null;/);
  });
});

describe("focus never stays on a hidden or disabled control", () => {
  it("Tune in hands focus to Pause once Pause is shown", () => {
    expect(main).toMatch(/pause\.hidden = false;\s*pause\.textContent = "Pause";\s*pause\.focus\(\);/);
  });

  it("every control the page hides is rescued first: Pause, Try again and the question's buttons", () => {
    const cases: [string, string][] = [
      ["pause", "rescueFocus(pause);"],
      ["retry", "rescueFocus(retry);"],
      ["ask", "rescueFocus(askYes, askNo);"],
    ];
    for (const [el, rescue] of cases) {
      const hides = [...main.matchAll(new RegExp(`\\n\\s*${el}\\.hidden = true;`, "g"))];
      expect(hides.length, el).toBeGreaterThan(0);
      for (const h of hides) expect(main.slice(Math.max(0, h.index! - 200), h.index!), `${el}.hidden = true`).toContain(rescue);
    }
  });

  it("the rescue goes to Tune in only when it is enabled, else to the dial; offAir re-enables Tune in first", () => {
    const rescue = block(main, "const rescueFocus = ")!;
    expect(rescue).toMatch(/if \(!tune\.disabled\) tune\.focus\(\);\s*else device\.querySelector<HTMLElement>\("\[data-dialwin\]"\)\?\.focus\(\);/);
    const offAir = block(main, "const offAir = () => {")!;
    expect(offAir.indexOf("paintTuneIn()")).toBeGreaterThan(-1);
    expect(offAir.indexOf("paintTuneIn()")).toBeLessThan(offAir.indexOf("rescueFocus(pause)"));
  });
});

describe("the live region announces state changes only", () => {
  it("only announce() writes #broadcast-status; the per-line count goes to a visual-only line", () => {
    const radioPart = main.slice(main.indexOf("function setupRadio"), main.indexOf("function setupFeedback"));
    expect([...radioPart.matchAll(/status\.textContent = /g)].length).toBe(1);
    expect(main).toMatch(/if \(status\.textContent !== line\) status\.textContent = line;/);
    const html = read("web/index.html");
    expect(html).toContain('<p id="broadcast-status" role="status" aria-live="polite"></p>');
    // Readable, but not a live region, so it does not announce each line.
    expect(html).toContain('<p id="broadcast-progress"></p>');
  });

  it("a new cue or a new line repaints the progress, never the announcement (except the first line going on air)", () => {
    const cue = /msg\.type === "cue"\) \{([\s\S]*?)\} else if \(msg\.type === "done"\)/.exec(main)![1]!;
    expect(cue).toContain("paintProgress()");
    expect(cue).not.toContain("announce(");
    const follow = block(main, "const follow = () => {", 4)!;
    expect([...follow.matchAll(/announce\(/g)].length).toBe(1);
    expect(follow).toMatch(/if \(own\.line < 0 && audio\.state === "running"\) announce\(onAirLine/);
  });

  it("the progress line names the work, the heard line and how far it is made, and says Paused when paused", () => {
    const p = { title: "Crito", heard: 21, made: 40, total: 252, paused: false, renderDone: false };
    expect(progressLine(p)).toBe("On air: Crito, line 21 of 252. Made up to line 40.");
    expect(progressLine({ ...p, paused: true })).toBe("Paused: Crito, line 21 of 252. Made up to line 40.");
    expect(progressLine({ ...p, paused: true, renderDone: true, made: 252 })).toBe("Paused: Crito, line 21 of 252. All lines made.");
  });
});

describe("tuning away while a work is on air", () => {
  it("the question hides itself when the old broadcast finishes making or stops", () => {
    const offAir = block(main, "const offAir = () => {")!;
    expect(offAir).toContain("hideAsk();");
    const done = /msg\.type === "done"\) \{([\s\S]*?)\n {6}\} else \{/.exec(main)![1]!;
    expect(done).toContain("hideAsk();");
    const hideAsk = block(main, "const hideAsk = () => {")!;
    expect(hideAsk).toMatch(/rescueFocus\(askYes, askNo\);\s*ask\.hidden = true;/);
  });

  it("Tune in on the work reads Paused, not On air, when paused with every line made", () => {
    const paint = block(main, "const paintTuneIn = () => {")!;
    expect(paint).toMatch(/const lit = here && lampLit\(lampState\(\)\);/);
    expect(paint).toContain('tune.textContent = here ? (lit ? "On air" : "Paused") : "Tune in";');
    expect(paint).toContain('tune.classList.toggle("is-on-air", lit);');
    // Every lamp change repaints it, including the pause handler's.
    expect(block(main, "const setLamp = () => {")).toContain("paintTuneIn();");
    expect(main).toMatch(/const settle = \(\) => \{\s*setLamp\(\);/);
  });

  it("asks in the page before stopping a work still being made, naming both", () => {
    expect(switchQuestion("Crito", "the Cave")).toBe("Stop Crito and tune in to the Cave? Crito's recording so far will be lost.");
    expect(switchQuestion("the Cave", "Crito")).toBe("Stop the Cave and tune in to Crito? The Cave's recording so far will be lost.");
    expect(switchQuestion("the Meditations", "Crito")).toBe("Stop the Meditations and tune in to Crito? The Meditations' recording so far will be lost.");
    expect(main).not.toMatch(/\bconfirm\(/);
    expect(main).toMatch(
      /if \(s\?\.live && s\.work !== work && !s\.renderDone\) \{\s*pending = work;\s*askQ\.textContent = switchQuestion\(s\.work\.called, work\.called\);\s*ask\.hidden = false;/,
    );
  });

  it("the read-along and the download name the work they belong to", () => {
    // The catalogue number is only in the dial's readout and the Bookplate (founder, 2026-09-26).
    expect(main).toContain("raWho.textContent = `On air: ${work.title}`;");
    expect(main).toContain("download.textContent = `Download ${work.called} as an audio file`;");
  });
});

describe("pointer capture", () => {
  it("capture() reports a refused capture instead of throwing", () => {
    const refused = {
      setPointerCapture: () => {
        throw new Error("NotFoundError");
      },
    } as unknown as Element;
    const granted = { setPointerCapture: () => {} } as unknown as Element;
    expect(capture(refused, { pointerId: 1 } as PointerEvent)).toBe(false);
    expect(capture(granted, { pointerId: 1 } as PointerEvent)).toBe(true);
  });

  it("a drag starts only on the main button and once the capture holds; a lost capture is a release", () => {
    expect(radioSrc).toMatch(/if \(e\.button !== 0\) return;\s*\/\/[^\n]*\n\s*if \(!capture\(win, e\)\) return;\s*dragging = true;/);
    expect(radioSrc).toMatch(/if \(e\.button !== 0 \|\| !capture\(knob, e\)\) return;\s*lastAngle = at\(e\);/);
    expect(radioSrc).toContain('win.addEventListener("lostpointercapture", release);');
    expect(radioSrc).toContain('knob.addEventListener("lostpointercapture", up);');
    expect(radioSrc).not.toMatch(/^\s*(win|knob)\.setPointerCapture/m);
  });
});

describe("the small things", () => {
  it("both Jowett works say First published 1871", () => {
    for (const w of WORKS.slice(0, 2)) expect(bookplateHtml(w)).toContain("First published <span data-numeral>1871</span>");
  });

  it("the Voice row names the cast only where the text labels its speakers", () => {
    const casts = WORKS.map((w) => cast(segment(text(w.slug)), w.cast));
    expect(casts.map((c) => c.parts.length)).toEqual([0, 2, 0]);
    expect(bookplateHtml(WORKS[1]!, casts[1])).toContain("Socrates: Fenrir. Crito: Puck. Voices are cast in one accent, by the voice model's published grade and their measured contrast, never from the speakers' names.");
    for (const i of [0, 2]) expect(bookplateHtml(WORKS[i]!, casts[i])).not.toMatch(/Socrates:|Speaker names/);
  });

  it("the Tune knob reports the station as its value", () => {
    expect(radioSrc).toContain('tuneKnob?.setAttribute("aria-valuenow", String(tuned + 1));');
  });

  it("the card repaints once the radio is mounted, not once the texts arrive", () => {
    expect(main).toMatch(/onTune: \(\) => \{\s*if \(!mounted\) return;\s*showStation\(\);/);
    expect(main).not.toMatch(/texts\.size/);
  });

  it("the page names the host it runs on, never a hard-coded domain", () => {
    expect(main).not.toMatch(/voidvision/);
    expect(main).toContain("loadingNote(location.host)");
    expect(main).toContain("stationsUnreached(location.host)");
  });
});
