// T1: the Spark page follows the G2-approved colour and copy rules
// (design/spec.md 1.1 and 6). Tally is a lamp, never a text ground; errors
// earn no hue; the first voice download is stated from the staged bytes and
// the runtime is pinned; the em-dash lint never reads an author's verbatim
// text.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ORT_FILES, ORT_WASM, STAGED_DIRS, VOICES, stage } from "../scripts/fetch-voice.mjs";
import { checkColorLine, checkEmDashLine, isVerbatimPath, shouldScan } from "../scripts/lint-design.mjs";
import { walk } from "../scripts/lib/walk.mjs";
import { aboutMegabytes, isStatableTotal, warmingLine } from "../web/src/download-size";
import { NOT_KEPT, STOP_OFFLINE, STOP_SERVER, STOP_STORAGE, firstLineLine, onAirLine, pausedLine, renderedLine, stopLine } from "../web/src/status-copy";
import { lampLit } from "../web/src/broadcast-state";
import { runtimeCacheKey, runtimeCacheName, staleVoiceCaches, voiceCacheName } from "../web/src/voice-cache";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const css = read("web/src/style.css");
const main = read("web/src/main.ts");
const voiceSrc = read("web/src/voice.ts");
const indexHtml = read("web/index.html");
const privacyHtml = read("web/privacy.html");
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");
const manifestPath = () => path.join(STAGED_DIRS.voice, "manifest.json");

/** Every rule in the stylesheet as [selector, declarations]. The Spark CSS has no nesting. */
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (m) => [m[1]!.trim(), m[2]!] as const,
);
const decl = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim();

describe("tally is a lamp only", () => {
  it("the on-air button has a cream label on no tally ground", () => {
    const onAir = rules.filter(([sel]) => /data-on-air/.test(sel) && /#tune-in/.test(sel) && !/::/.test(sel));
    expect(onAir.length).toBeGreaterThan(0);
    for (const [, body] of onAir) {
      expect(decl(body, "background") ?? "").not.toContain("--color-tally");
      expect(decl(body, "background-color") ?? "").not.toContain("--color-tally");
      expect(decl(body, "color")).toBe("var(--color-cream)");
    }
  });

  it("while on air the button lights a small tally lamp beside its label", () => {
    const lamp = rules.find(([sel]) => /data-on-air/.test(sel) && /#tune-in[^\s]*::before/.test(sel));
    expect(lamp).toBeDefined();
    const body = lamp![1];
    expect(decl(body, "background")).toBe("var(--color-tally)");
    expect(decl(body, "content")).toBe('""');
    for (const side of ["width", "height"]) expect(Number.parseFloat(decl(body, side)!)).toBeLessThanOrEqual(12);
  });

  it("tally is never a text colour or a ground for text anywhere in the stylesheet", () => {
    for (const [sel, body] of rules) {
      if (!body.includes("--color-tally")) continue;
      // Only a text-less pseudo-element lamp may carry tally.
      expect(sel, sel).toMatch(/::(before|after)$/);
      expect(decl(body, "content"), sel).toBe('""');
      expect(decl(body, "color") ?? "", sel).not.toContain("--color-tally");
    }
  });
});

describe("errors earn no hue", () => {
  for (const id of ["broadcast-status", "feedback-status"]) {
    it(`#${id}[data-state="error"] is cream prose`, () => {
      const rule = rules.find(([sel]) => sel === `#${id}[data-state="error"]`);
      expect(rule).toBeDefined();
      expect(decl(rule![1], "color")).toBe("var(--color-cream)");
      expect(rule![1]).not.toContain("--color-tally");
    });
  }
});

describe("the meter never outlives the work", () => {
  it("a hidden meter is not drawn", () => {
    const rule = rules.find(([sel]) => sel === "progress[hidden]");
    expect(rule).toBeDefined();
    expect(decl(rule![1], "display")).toBe("none");
  });

  it("a failure hides the meter and marks the status as an error", () => {
    const stopped = /const stopped = \(message: string\) => \{([\s\S]*?)\n {4}\};/.exec(main)?.[1];
    expect(stopped).toBeDefined();
    expect(stopped).toContain("meter.hidden = true");
    // Plain words, never the raw engine text, announced as an error.
    expect(stopped).toContain("announce(stopLine(message), true)");
    expect(main).toMatch(/const announce = \(line: string, error = false\) => \{\s*if \(error\) status\.dataset\.state = "error";/);
    // The worker's error message (a failed manifest fetch or parse lands
    // there) and a worker that fails outright both end in stopped().
    expect(main).toMatch(/\} else \{\s*stopped\(msg\.message\);/);
    expect(main).toMatch(/worker\.onerror = [\s\S]*?stopped\(/);
  });
});

describe("the lamp is lit only while a render or playback is live", () => {
  const block = (name: string) => new RegExp(`const ${name} = \\([^)]*\\) => \\{([\\s\\S]*?)\\n {2,4}\\};`).exec(main)?.[1];

  it("tally means a render or playback is live: paused while lines are still being made keeps it lit", () => {
    expect(lampLit(null)).toBe(false);
    expect(lampLit({ live: true, playing: true, renderDone: false })).toBe(true);
    // T1 review: pausing while the render still runs must not put the lamp out.
    expect(lampLit({ live: true, playing: false, renderDone: false })).toBe(true);
    expect(lampLit({ live: true, playing: true, renderDone: true })).toBe(true);
    expect(lampLit({ live: true, playing: false, renderDone: true })).toBe(false);
    expect(lampLit({ live: false, playing: true, renderDone: false })).toBe(false);
  });

  it("only setLamp writes on-air, from lampLit over the live session's state", () => {
    expect([...main.matchAll(/dataset\.onAir = /g)].length).toBe(1);
    const setLamp = block("setLamp");
    expect(setLamp).toMatch(/const lit = lampLit\(lampState\(\)\);/);
    expect(main).toContain('const lampState = () => session && { live: session.live, playing: session.audio.state === "running", renderDone: session.renderDone };');
    expect(setLamp).toMatch(/if \(lit\) document\.body\.dataset\.onAir = "true";\s*else delete document\.body\.dataset\.onAir;/);
  });

  it("a stop takes the broadcast off air: lamp off, Pause hidden, Tune in back for a retry", () => {
    expect(block("stopped")).toContain("offAir()");
    const offAir = block("offAir");
    expect(offAir).toBeDefined();
    expect(offAir).toContain("s.live = false");
    expect(offAir).toContain("setLamp()");
    expect(offAir).toContain("pause.hidden = true");
    expect(offAir).toContain("paintTuneIn()");
    // Tune in is enabled again whenever the tuned work is not the one on air.
    // Tune in is enabled for a tuned work that is read and cast; a station that could not be cast stays off (T2b).
    expect(block("paintTuneIn")).toMatch(/tune\.disabled = here \|\| !texts\.get\(w\.slug\)\?\.cast/);
  });

  it("the lamp is re-read when every line is made, and goes off when the last scheduled line ends", () => {
    expect(main).toMatch(/node\.onended = \(\) => \{\s*playing--;\s*ended\(\);/);
    expect(block("ended")).toMatch(/own\.renderDone && playing === 0\) \{\s*offAir\(\);/);
    expect(main).toMatch(/msg\.type === "done"\) \{[\s\S]*?own\.renderDone = true;[\s\S]*?setLamp\(\);[\s\S]*?ended\(\);/);
  });

  it("pausing and resuming re-read the lamp, and so does every audio state change", () => {
    expect(main).toMatch(/s\.audio\.suspend\(\)\.then\(settle\)/);
    expect(main).toMatch(/s\.audio\.resume\(\)\.then\(settle\)/);
    expect(main).toMatch(/const settle = \(\) => \{\s*setLamp\(\);/);
    expect(main).toContain("audio.onstatechange = setLamp");
  });
});

describe("a stopped render says what happened in plain words", () => {
  it("maps known failures to the real fix and everything else to one generic line", () => {
    expect(stopLine("TypeError: Failed to fetch")).toBe("Could not reach Dial. Check your connection, then press Tune in again.");
    expect(stopLine("TypeError: NetworkError when attempting to fetch resource.")).toBe(STOP_OFFLINE);
    // An HTTP status from Dial is a server error, not a connection problem (T1 review).
    expect(stopLine("Error: voice part model_quantized.part2: 503")).toBe("Dial could not send the voice. Try again later.");
    expect(stopLine("Error: voice manifest: 404")).toBe(STOP_SERVER);
    expect(stopLine("Error: voice runtime: 500")).toBe(STOP_SERVER);
    expect(STOP_SERVER).not.toMatch(/connection/);
    expect(stopLine("QuotaExceededError: The quota has been exceeded.")).toBe(
      "This device is out of storage for the voice. Free some space, then press Tune in again.",
    );
    expect(stopLine("QuotaExceededError: there is no room to keep the voice on this device")).toBe(STOP_STORAGE);
    for (const raw of ["", "RuntimeError: unreachable", "SyntaxError: Unexpected token '<'", "Error: voice: the model did not match its pin"]) {
      expect(stopLine(raw)).toBe("The voice stopped unexpectedly. Press Tune in to try again.");
    }
  });

  it("never passes engine text through", () => {
    for (const raw of ["TypeError: Failed to fetch", "RuntimeError: unreachable", "Error: voice runtime: 500"]) {
      expect(stopLine(raw)).not.toContain(raw);
      expect(stopLine(raw)).not.toMatch(/Error|fetch|—|!/);
    }
  });

  it("says so when the voice could not be kept, while rendering and when done", () => {
    expect(onAirLine("Crito", true)).toBe("On air: Crito. Made on this device as you listen.");
    expect(onAirLine("Crito", false)).toBe(`On air: Crito. Made on this device as you listen. ${NOT_KEPT}`);
    expect(firstLineLine("Crito", true)).toBe("Making the first line of Crito on this device.");
    expect(renderedLine("Crito", 118, 1212, false)).toContain(NOT_KEPT);
    // A count is sent when a work is made (chapter_rendered), so the line claims only what stays: the words and the audio.
    expect(renderedLine("The Allegory of the Cave", 118, 1212, true)).toBe(
      "Made on this device: all 118 lines of The Allegory of the Cave, 20:12. The words and the audio never left this device.",
    );
    // Listener copy never says "render" (design/spec.md 1.8), and no line claims nothing was sent.
    const lines = [onAirLine("Crito", true), firstLineLine("Crito", true), renderedLine("Crito", 118, 1212, true), pausedLine("Crito", 87, true)];
    for (const line of lines) expect(line).not.toMatch(/render|nothing was sent|sends nothing|sent nothing/i);
    expect(NOT_KEPT).toBe("The voice could not be kept on this device, so it will download again next time.");
    // The loader reports it: any failed write clears kept, and ready carries it.
    expect(voiceSrc).toMatch(/if \(!\(await keep\(c, key, response\)\)\) kept = false;/);
    expect(main).toMatch(/own\.kept = msg\.kept;/);
  });

  it("the status line's counts and sizes use tabular figures", () => {
    const rule = rules.find(([sel]) => sel === "#broadcast-status");
    expect(rule).toBeDefined();
    expect(decl(rule![1], "font-variant-numeric")).toBe("tabular-nums");
  });
});

describe("true copy: the first voice download", () => {
  beforeAll(async () => {
    // The gate builds (and so stages) before tests; stage here if run alone.
    if (!existsSync(manifestPath())) await stage();
  }, 120_000);

  it("the manifest's totalBytes equals the sum of the staged files (manifest excluded)", () => {
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as { totalBytes: number; parts: string[] };
    let sum = 0;
    const kinds = { part: 0, voice: 0, mjs: 0, wasm: 0 };
    for (const dir of [STAGED_DIRS.voice, STAGED_DIRS.ort]) {
      for (const file of walk(dir)) {
        if (path.resolve(file) === path.resolve(manifestPath())) continue;
        sum += statSync(file).size;
        if (/\.part\d+$/.test(file)) kinds.part++;
        if (file.endsWith(".bin")) kinds.voice++;
        if (file.endsWith(".mjs")) kinds.mjs++;
        if (file.endsWith(".wasm")) kinds.wasm++;
      }
    }
    // Everything the tab downloads for the voice is in the sum.
    expect(kinds.part).toBe(manifest.parts.length);
    // Every voice the cast can use (George, Heart, Fable, Lewis) is in the total.
    expect(kinds.voice).toBe(Object.keys(VOICES).length);
    expect(kinds.voice).toBe(4);
    expect(kinds.mjs).toBe(1);
    expect(kinds.wasm).toBe(1);
    expect(manifest.totalBytes).toBe(sum);
  });

  it("the runtime and the voice file are pinned: the manifest carries their sha256", () => {
    const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as { runtime: string; runtimeSha256: string; voices: Record<string, string> };
    expect(manifest.voices).toEqual(VOICES);
    for (const [id, pin] of Object.entries(VOICES)) {
      expect(sha256(readFileSync(path.join(STAGED_DIRS.voice, "voices", `${id}.bin`))), id).toBe(pin);
    }
    expect(manifest.runtime).toBe(ORT_WASM);
    expect(manifest.runtimeSha256).toBe(ORT_FILES[ORT_WASM]);
    for (const [file, pin] of Object.entries(ORT_FILES)) {
      expect(sha256(readFileSync(path.join(STAGED_DIRS.ort, file))), file).toBe(pin);
    }
  });

  it("a runtime pin mismatch fails staging before anything on disk changes", async () => {
    const before = readFileSync(manifestPath(), "utf8");
    const wrong = { ...ORT_FILES, [ORT_WASM]: "0".repeat(64) };
    await expect(stage({ ortPins: wrong })).rejects.toThrow(/sha256 \w+, pinned 0{64}/);
    expect(readFileSync(manifestPath(), "utf8")).toBe(before);
  });

  it("states the size rounded from the total", () => {
    expect(aboutMegabytes(114_527_513)).toBe("about 115 MB");
    expect(aboutMegabytes(89_600_000)).toBe("about 90 MB");
    expect(warmingLine(114_527_513, "all", "Crito")).toBe("Warming the voice. It downloads once (about 115 MB) and is kept on this device.");
    expect(warmingLine(114_527_513, "all", "Crito")).not.toMatch(/—|!/);
  });

  it("claims no download on a repeat visit, and no size without a usable total", () => {
    expect(warmingLine(0, "none", "Crito")).toBe("Warming the voice from this device.");
    for (const bad of [undefined, null, Number.NaN, Infinity, 0, -5, "115"]) {
      expect(isStatableTotal(bad)).toBe(false);
      expect(warmingLine(bad, "all", "Crito")).toBe("Warming the voice.");
    }
    expect(isStatableTotal(114_527_513)).toBe(true);
  });

  it("the page computes the size and the meter's max from the manifest total, never a hard-coded guess", () => {
    expect(main).not.toMatch(/\d+\s*MB/);
    expect(main).not.toMatch(/MODEL_BYTES/);
    expect(main).toMatch(/if \(isStatableTotal\(msg\.total\)\) \{\s*meter\.max = msg\.total;/);
    expect(main).toMatch(/warmingLine\(msg\.total, msg\.need, work\.called, msg\.missingVoices\)/);
  });

  it("the page's offline claims ship with the offline helper that makes them true (T4)", () => {
    // Offline exists from T4: the helper is registered from main.ts and built to dist/sw.js.
    expect(main).toMatch(/^registerOfflineHelper\(\);$/m);
    expect(read("scripts/build.mjs")).toContain("await buildServiceWorker(tag, shell, readVoicePins());");
    expect(privacyHtml).toContain("Saved for offline");
  });
});

describe("the voice caches are keyed to their pins", () => {
  const pins = { revision: "1939ad2a", runtime: ORT_WASM, runtimeSha256: ORT_FILES[ORT_WASM] };

  it("the runtime has its own cache named for its sha, and its key carries the full sha", () => {
    expect(runtimeCacheName(pins)).toBe(`dial-runtime-${pins.runtimeSha256.slice(0, 16)}`);
    expect(runtimeCacheKey(pins)).toContain(pins.runtimeSha256);
    expect(runtimeCacheKey(pins)).toMatch(/^\/ort\//);
  });

  it("the model cache is keyed on the Kokoro revision only, so a runtime-only bump keeps the model", () => {
    expect(voiceCacheName(pins)).toBe("dial-voice-1939ad2a");
    const bumped = { ...pins, runtimeSha256: "f".repeat(64) };
    expect(voiceCacheName(bumped)).toBe(voiceCacheName(pins));
    expect(runtimeCacheName(bumped)).not.toBe(runtimeCacheName(pins));
  });

  it("the purge keeps exactly the current two and leaves other caches alone", () => {
    const current = [voiceCacheName(pins), runtimeCacheName(pins)];
    const names = ["dial-voice-old", ...current, "kokoro-voices", "dial-runtime-0000000000000000", "dial-voice-1939ad2a-c46655e8a94afc45"];
    expect(staleVoiceCaches(names, current)).toEqual(["dial-voice-old", "dial-runtime-0000000000000000", "dial-voice-1939ad2a-c46655e8a94afc45"]);
  });

  it("the loader checks the runtime and the voice file against their pins on read and on fetch, purges, and survives a full quota", () => {
    expect(voiceSrc).toMatch(/const current = \[voiceCacheName\(manifest\), runtimeCacheName\(manifest\)\];/);
    expect(voiceSrc).toMatch(/staleVoiceCaches\(await caches\.keys\(\), current\)\) await caches\.delete/);
    // On read: a cached file that fails its pin is dropped, then fetched again.
    expect(voiceSrc).toMatch(/if \(\(await sha256Hex\(hit\)\) !== pin\) \{\s*await cache\.delete\(key\);\s*return undefined;\s*\}\s*return hit;/);
    expect(voiceSrc).toMatch(/for \(const id of cast\) \{\s*if \(await dropIfUnpinned\(voices, voiceKey\(id\), manifest\.voices\[id\]!\)\) heldVoices\.add\(id\);/);
    // T1 review: the runtime's .wasm is read and hashed once per load; the checked bytes are the ones handed over.
    expect(voiceSrc).toContain("const cachedRuntime = await dropIfUnpinned(runtimeCache, runtimeKey, manifest.runtimeSha256);");
    expect(voiceSrc).toContain("let binary = cachedRuntime;");
    expect([...voiceSrc.matchAll(/runtimeCache\.match\(/g)].length).toBe(0);
    // On fetch: a file that fails its pin is never used or kept.
    expect(voiceSrc).toMatch(/if \(\(await sha256Hex\(binary\)\) !== manifest\.runtimeSha256\) throw/);
    expect(voiceSrc).toMatch(/if \(\(await sha256Hex\(buf\)\) !== pin\) throw/);
    expect(voiceSrc).toMatch(/async function keep[\s\S]*?try \{\s*await cache\.put/);
    expect(voiceSrc).toMatch(/await hold\(runtimeCache, runtimeKey, new Response\(binary/);
  });
});

describe("the em-dash lint never reads verbatim author text", () => {
  it("text files under web/public/works/ are exempt from the em-dash check", () => {
    for (const p of ["web/public/works/cave.txt", "web/public/works/crito/crito.txt"]) {
      expect(isVerbatimPath(p)).toBe(true);
      expect(checkEmDashLine(p, "unenlightened:—Behold!")).toBeNull();
    }
  });

  it("the exemption is the em-dash check on text only: other files there are fully checked, colour everywhere", () => {
    for (const p of ["web/public/works/cave.html", "web/public/works/crito/notes.ts"]) {
      expect(isVerbatimPath(p)).toBe(false);
      expect(shouldScan(p)).toBe(true);
      expect(checkColorLine(p, "color: #ff0000;")).toMatch(/color literal/);
    }
    expect(checkEmDashLine("web/public/works/cave.html", "a — b")).toMatch(/em dash/);
  });

  it("Dial's own UI copy is still checked", () => {
    for (const p of ["web/index.html", "web/privacy.html", "web/src/main.ts"]) {
      expect(isVerbatimPath(p)).toBe(false);
      expect(shouldScan(p)).toBe(true);
      expect(checkEmDashLine(p, "Tune in — now")).toMatch(/em dash/);
    }
    // A folder named like works, but not the verbatim one, gets no pass.
    expect(isVerbatimPath("web/public/works-list.txt")).toBe(false);
    expect(checkEmDashLine("web/public/works-list.html", "a — b")).toMatch(/em dash/);
  });
});
