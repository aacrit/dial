// T4: Save for offline, the offline helper and the installable app.
// The helper's routing, the save and remove sets and the save row's words
// are pure functions, held here without a browser; the helper's own
// requests, the app manifest's colours and the contract are checked from
// source and the build.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { SECURITY_HEADERS } from "../scripts/lib/csp.mjs";
import { iconFiles, nightTokens, resolveHex, stampTokens } from "../scripts/lib/pwa.mjs";
import { WORKS } from "../web/src/catalogue";
import { tryCast } from "../web/src/engine/cast";
import { segment } from "../web/src/engine/segment";
import { INSTALL_SNOOZE_DAYS, installCard, isIosSafari, type InstallInput } from "../web/src/offline/install";
import {
  OFFLINE_NOTICE,
  WORK_NOT_ON_DEVICE,
  parseVoices,
  isSaved,
  SAVED_OLDER,
  SAVED_OLDER_LINE,
  savedState,
  saveEndLine,
  unionVoices,
  kilobytes,
  offlineExtras,
  onDeviceBytes,
  planTotal,
  saveFailedLine,
  savePlan,
  savedLine,
  savingLine,
  sizeLine,
  voicesToRemove,
  workVoices,
} from "../web/src/offline/plan";
import { SAVED_CACHE, isNeverCached, isPage, isThisBuild, offlineKey, pageHeaders, pinsOf, route, shellCacheName, shellKey, shellPaths, staleShellCaches } from "../web/src/offline/routes";
import { CAST_ENGINE_VERSION } from "../web/src/engine/cast";
import type { Held, SizedManifest } from "../web/src/voice-cache";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const ORIGIN = "https://dial.voidvision.org";
const at = (p: string) => new URL(p, ORIGIN);

describe("the offline helper's routing", () => {
  it("never answers or caches the Worker's routes or its own script, so offline they fail as they would without it", () => {
    for (const p of ["/e", "/feedback", "/healthz", "/api/licence", "/sw.js"]) {
      expect(isNeverCached(p), p).toBe(true);
      expect(route(at(p), "GET", ORIGIN), p).toBe("ignore");
    }
    expect(route(at("/e"), "POST", ORIGIN)).toBe("ignore");
    expect(route(at("/feedback"), "POST", ORIGIN)).toBe("ignore");
    // Not a prefix match on unrelated paths.
    expect(isNeverCached("/eels.html")).toBe(false);
  });

  it("answers only this origin's GET requests", () => {
    expect(route(new URL("https://huggingface.co/x/resolve/main/voices/a.bin"), "GET", ORIGIN)).toBe("ignore");
    expect(route(new URL("https://example.com/"), "GET", ORIGIN, "navigate")).toBe("ignore");
    expect(route(at("/"), "POST", ORIGIN, "navigate")).toBe("ignore");
  });

  it("serves pages network first, the shell from its cache, and saved works from the saved cache offline", () => {
    expect(route(at("/"), "GET", ORIGIN, "navigate")).toBe("page");
    expect(route(at("/privacy"), "GET", ORIGIN, "navigate")).toBe("page");
    expect(route(at("/privacy.html"), "GET", ORIGIN)).toBe("page");
    expect(route(at("/assets/main-abc.js"), "GET", ORIGIN)).toBe("shell");
    expect(route(at("/assets/inter-latin-400-normal-x.woff2"), "GET", ORIGIN)).toBe("shell");
    expect(route(at("/manifest.webmanifest"), "GET", ORIGIN)).toBe("shell");
    expect(route(at("/works/cave.txt"), "GET", ORIGIN)).toBe("saved");
    expect(route(at("/voice/manifest.json"), "GET", ORIGIN)).toBe("saved");
    expect(route(at("/ort/ort-wasm-simd-threaded.jsep.mjs"), "GET", ORIGIN)).toBe("saved");
    // The big files are the page's own to keep (voice.ts, offline/store.ts), never the helper's.
    for (const p of ["/voice/models/r/onnx/model_quantized.part0", "/voice/voices/bm_george.bin", "/ort/ort-wasm-simd-threaded.jsep.wasm", "/works/../sw.js"]) {
      expect(route(at(p), "GET", ORIGIN), p).not.toBe("shell");
    }
  });

  it("names the shell cache for the build and purges every other build's on activate, and no other cache", () => {
    expect(shellCacheName("release/2026.09.26-3")).toBe("dial-shell-release/2026.09.26-3");
    const names = ["dial-shell-abc1234", "dial-shell-def5678", SAVED_CACHE, "kokoro-voices", "dial-voice-1939", "dial-device"];
    expect(staleShellCaches(names, "def5678")).toEqual(["dial-shell-abc1234"]);
    expect(staleShellCaches(names, "new")).toEqual(["dial-shell-abc1234", "dial-shell-def5678"]);
  });

  it("the shell is the pages, scripts, styles, fonts, manifest and icons: never the voice, the texts, the runtime's .wasm or the helper", () => {
    const files = [
      "index.html",
      "privacy.html",
      "assets/main-a.js",
      "assets/narrate.worker-b.js",
      "assets/style-c.css",
      "assets/inter-d.woff2",
      "assets/ort-wasm-simd-threaded.jsep-e.wasm",
      "manifest.webmanifest",
      "icons/dial-192.png",
      "voice/manifest.json",
      "voice/voices/bm_george.bin",
      "ort/ort-wasm-simd-threaded.jsep.mjs",
      "works/cave.txt",
      "_headers",
      "build-tag.txt",
      "sw.js",
      "assets/main-a.js.map",
    ];
    expect(shellPaths(files)).toEqual(["/", "/assets/inter-d.woff2", "/assets/main-a.js", "/assets/narrate.worker-b.js", "/assets/style-c.css", "/icons/dial-192.png", "/manifest.webmanifest", "/privacy"]);
    expect(shellKey("/index.html")).toBe("/");
    expect(shellKey("/privacy.html")).toBe("/privacy");
  });

  it("a page answered from the cache keeps cross-origin isolation and the security headers", () => {
    const h = pageHeaders(new Headers({ "content-type": "text/html" }));
    expect(h.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(h.get("cross-origin-embedder-policy")).toBe("require-corp");
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(h.get(k)).toBe(v);
    expect(h.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(h.get("content-type")).toBe("text/html");
  });
});

describe("Law 1: the offline helper fetches only this origin's own files", () => {
  const sw = read("web/src/sw.ts");

  it("its only requests are the page's own (after routing) and the shell's paths", () => {
    const calls = [...sw.matchAll(/\bfetch\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(["request", 'path, { cache: "reload" }'], c).toContain(c);
    // The shell's paths come from the build's list; the page's request only after route() said this origin.
    expect(sw).toMatch(/for \(const path of __SHELL__\)/);
    expect(sw).toMatch(/const r = route\(new URL\(request\.url\), request\.method, sw\.location\.origin, request\.mode\);\s*if \(r === "ignore"\) return;/);
    expect(sw).not.toMatch(/sendBeacon|WebSocket|EventSource|XMLHttpRequest|method:\s*"POST"/);
  });

  it("the built helper's shell list names only same-origin paths", () => {
    const built = path.join(root, "dist", "sw.js");
    // The gate builds before it tests: a missing helper is a failure, not a skip.
    expect(existsSync(built), "dist/sw.js: run npm run build first").toBe(true);
    const list = /`(\/[^`]*)`\.split\(`,`\)/.exec(readFileSync(built, "utf8"))?.[1];
    expect(list).toBeDefined();
    for (const p of list!.split(",")) {
      expect(p.startsWith("/") && !p.startsWith("//"), p).toBe(true);
      expect(p, p).not.toMatch(/^\/(voice|ort|works)\/|\.wasm$|^\/sw\.js$|^\/e$|^\/feedback$/);
    }
    expect(list!.split(",")).toContain("/");
    // privacy.html says the shell is about 3 MB.
    const bytes = list!.split(",").reduce((sum, p) => {
      const f = path.join(root, "dist", p === "/" ? "index.html" : p === "/privacy" ? "privacy.html" : p.slice(1));
      return sum + readFileSync(f).byteLength;
    }, 0);
    expect(Math.round(bytes / 1_000_000)).toBe(3);
  });

  it("a partial shell never replaces a complete one", () => {
    const sw = read("web/src/sw.ts");
    // Install fails on an incomplete shell, so the previous helper keeps serving.
    expect(sw).toMatch(/precache\(\)\.then\(\(ok\) => \{\s*if \(!ok\) throw/);
    // A fetched home page from another build is refused.
    // Every page kept (not only "/") must be this build's.
    expect(sw).toContain('if (isPage(copy.headers.get("content-type")) && !isThisBuild(await copy.clone().text(), __BUILD_TAG__)) throw');
    expect(isPage("text/html; charset=utf-8")).toBe(true);
    expect(isPage("application/javascript")).toBe(false);
    expect(isPage(null)).toBe(false);
    expect(isThisBuild('<meta name="build" content="abc1234" />', "abc1234")).toBe(true);
    expect(isThisBuild('<meta name="build" content="def5678" />', "abc1234")).toBe(false);
    expect(isThisBuild("<p>no meta</p>", "abc1234")).toBe(false);
    // "Saved" needs every shell path, checked by the helper for this page's build.
    expect(sw).toMatch(/for \(const path of __SHELL__\) if \(!\(await cache\.match\(path\)\)\) return false;/);
    const store = read("web/src/offline/store.ts");
    expect(store).toContain("const helper = \"serviceWorker\" in navigator ? navigator.serviceWorker.controller : null;");
    expect(store).toContain("resolve({ ok: e.data?.ok === true, key: typeof e.data?.key === \"string\" ? e.data.key : null });");
    expect(store).toContain('return askHelper("shell-status", timeoutMs);');
    expect(read("web/src/offline/ui.ts")).toContain("const saved = savedState(plan, await shellState(), offlineKey(pinsOf(manifest.manifest), CAST_ENGINE_VERSION));");
  });

  it("the save row shows only where the helper also serves the render worker's requests", () => {
    const probe = read("web/src/offline/probe.worker.ts");
    // The default cache: the probe asks about routing, not freshness.
    expect(probe).toContain('fetch("/voice/manifest.json")');
    expect(probe).not.toContain("no-store");
    // After a no, it asks again only once a helper takes control (never on every station).
    expect(read("web/src/offline/store.ts")).toMatch(/if \(!ok && "serviceWorker" in navigator\) \{\s*navigator\.serviceWorker\.addEventListener\(\s*"controllerchange",\s*\(\) => \{\s*probe = null;/);
    expect(read("web/src/sw.ts")).toContain("headers.set(OFFLINE_HEADER, \"1\");");
    const ui = read("web/src/offline/ui.ts");
    expect(ui).toContain("let supported = false;");
    expect(ui).toMatch(/offlineWorks\(\)\.then\(\(ok\) => \{\s*if \(!ok \|\| supported\) return;\s*supported = true;/);
  });

  it("saving fetches only allowlisted downloads, and sends nothing", () => {
    const store = read("web/src/offline/store.ts");
    expect(store).not.toMatch(/method:\s*"POST"|sendBeacon/);
    const allow = JSON.parse(read("privacy-allowlist.json")) as { sends: string[]; downloads: string[] };
    expect(allow.sends).toEqual(["/e", "/feedback"]);
    for (const m of store.matchAll(/\bfetch\(\s*[`"]([^`"$]*)/g)) expect(allow.downloads.some((d) => m[1]!.startsWith(d)) || m[1] === "/voice/manifest.json", m[1]).toBe(true);
  });
});

// A manifest shaped like scripts/fetch-voice.mjs writes it.
const M: SizedManifest = {
  repo: "r",
  model: "onnx/model_quantized.onnx",
  parts: ["model_quantized.part0", "model_quantized.part1"],
  sizes: {
    "/voice/models/r/onnx/model_quantized.part0": 50_000_000,
    "/voice/models/r/onnx/model_quantized.part1": 42_400_000,
    "/voice/models/r/config.json": 2_000,
    "/voice/models/r/tokenizer.json": 3_000,
    "/ort/ort-wasm-simd-threaded.jsep.mjs": 50_000,
    "/ort/ort-wasm-simd-threaded.jsep.wasm": 21_550_000,
    "/voice/voices/bm_george.bin": 522_000,
    "/voice/voices/bm_fable.bin": 522_000,
    "/voice/voices/bm_lewis.bin": 522_000,
  },
};
const EXTRAS = [
  { path: "/voice/manifest.json", bytes: 2_100 },
  { path: "/ort/ort-wasm-simd-threaded.jsep.mjs", bytes: 50_000 },
];
const nothing: Held = { model: false, modelFiles: new Set(), runtime: false, voices: new Set() };
const everything = (voices: string[]): Held => ({ model: true, modelFiles: new Set(["/voice/models/r/config.json", "/voice/models/r/tokenizer.json"]), runtime: true, voices: new Set(voices) });

describe("save and remove", () => {
  const castOf = (slug: string) => {
    const w = WORKS.find((x) => x.slug === slug)!;
    const c = tryCast(segment(read(`web/public/works/${slug}.txt`)), w.cast)!;
    return workVoices(c.voices);
  };

  it("with any saved work's voice record unknown, Remove deletes no voice", () => {
    const saved = new Map<string, readonly string[] | null>([
      ["cave", ["bm_george"]],
      ["crito", null],
    ]);
    const today = new Map([
      ["cave", ["bm_george"]],
      ["crito", ["bm_george", "bm_fable"]],
    ]);
    expect(voicesToRemove("cave", saved, today)).toEqual([]);
    expect(voicesToRemove("crito", saved, today)).toEqual([]);
    expect(parseVoices(null)).toBeNull();
    expect(parseVoices("")).toBeNull();
    expect(parseVoices("bm_george,<img src=x>")).toBeNull();
    expect(parseVoices("bm_george,bm_fable")).toEqual(["bm_george", "bm_fable"]);
  });

  it("Remove reads the voices recorded at save time, never today's cast", () => {
    const store = read("web/src/offline/store.ts");
    expect(store).toContain("[VOICES_HEADER]: [...voices].join(\",\")");
    expect(store).toMatch(/export async function removeWork\(m: VoiceManifest, slug: string, todayCasts: ReadonlyMap<string, readonly string\[\]>\): Promise<void> \{\s*const records = await savedVoiceRecords\(\);/);
    // Each refresh widens a saved work's record to cover today's cast.
    expect(read("web/src/offline/ui.ts")).toMatch(/await coverVoiceRecord\(slug, voices\);\s*const plan = await planFor/);
  });

  it("recast: A saved with voice c, B saved before a recast that now needs c; removing A keeps c", () => {
    const records = new Map<string, readonly string[] | null>([
      ["a", ["c"]],
      ["b", ["x"]], // recorded before the recast
    ]);
    // With B's cast today (x and c), c survives.
    expect(voicesToRemove("a", records, new Map([["b", ["x", "c"]]]))).toEqual([]);
    // B's cast today unknown (its text is not on the page): no voice is deleted at all.
    expect(voicesToRemove("a", records, new Map())).toEqual([]);
    // Once refresh has widened B's record, it covers c too.
    const widened = new Map(records).set("b", unionVoices(records.get("b")!, ["x", "c"]));
    expect(widened.get("b")).toEqual(["x", "c"]);
    expect(voicesToRemove("a", widened, new Map([["b", ["x"]]]))).toEqual([]);
    // Control: a voice nobody else records or casts today does go.
    expect(voicesToRemove("a", records, new Map([["b", ["x"]]]))).toEqual(["c"]);
    expect(unionVoices(null, ["c"])).toEqual(["c"]);
    expect(unionVoices(["x", "c"], ["c"])).toEqual(["x", "c"]);
    // A refresh by the helper keeps the record.
    expect(read("web/src/sw.ts")).toContain('if (k.startsWith("x-dial-")) headers.set(k, v);');
  });

  it("a voice two saved works share survives removing one of them", () => {
    const saved = new Map([
      ["cave", ["bm_george"]],
      ["meditations", ["bm_george"]],
      ["crito", ["bm_george", "bm_fable", "bm_lewis"]],
    ]);
    expect(voicesToRemove("cave", saved, saved)).toEqual([]);
    expect(voicesToRemove("crito", saved, saved)).toEqual(["bm_fable", "bm_lewis"]);
    saved.delete("meditations");
    saved.delete("crito");
    expect(voicesToRemove("cave", saved, saved)).toEqual(["bm_george"]);
  });

  it("the real works: removing the Cave keeps the narrator the Meditations still use", () => {
    const saved = new Map([
      ["cave", castOf("cave")],
      ["meditations", castOf("meditations")],
    ]);
    const shared = castOf("cave").filter((v) => castOf("meditations").includes(v));
    expect(shared.length).toBeGreaterThan(0);
    for (const v of shared) expect(voicesToRemove("cave", saved, saved)).not.toContain(v);
  });

  it("the extras an offline Tune in needs are the voice manifest and the runtime's script, not its .wasm", () => {
    expect(offlineExtras(M)).toEqual(["/voice/manifest.json", "/ort/ort-wasm-simd-threaded.jsep.mjs"]);
  });

  it("a work is saved only when its text, every voice byte and the app's files are all on this device", () => {
    const voices = ["bm_george"];
    const full = savePlan(M, voices, everything(voices), 17_000, true, []);
    expect(isSaved(full, true)).toBe(true);
    expect(isSaved(full, false)).toBe(false);
    expect(isSaved(savePlan(M, voices, everything([]), 17_000, true, []), true)).toBe(false);
    expect(isSaved(savePlan(M, voices, everything(voices), 17_000, false, []), true)).toBe(false);
    expect(isSaved(savePlan(M, voices, everything(voices), 17_000, true, [{ path: "/voice/manifest.json", bytes: 2_000 }]), true)).toBe(false);
  });
});

describe("the save row's words, from measured bytes", () => {
  const voices = ["bm_george"];

  it("nothing held: the text's size plus the whole voice, once, from neededBytes plus the extras", () => {
    const p = savePlan(M, voices, nothing, 29_400, false, EXTRAS);
    // The runtime's script is counted once: with /ort/ while the runtime is not held.
    expect(p.voiceBytes).toBe(50_000_000 + 42_400_000 + 2_000 + 3_000 + 50_000 + 21_550_000 + 522_000 + 2_100);
    expect(sizeLine(p)).toBe("29 kB of text, plus the voice, once (about 115 MB).");
    expect(planTotal(p)).toBe(p.voiceBytes + 29_400);
  });

  it("the model held but not this work's voices: only they are named", () => {
    const p = savePlan(M, ["bm_george", "bm_fable", "bm_lewis"], everything(["bm_george"]), 30_000, false, []);
    expect(sizeLine(p)).toBe("30 kB of text, plus this work's voices (about 1 MB). The rest of the voice is already on this device.");
  });

  it("the whole voice held: only the text", () => {
    expect(sizeLine(savePlan(M, voices, everything(voices), 13_200, false, []))).toBe("13 kB of text. The voice is already on this device.");
    expect(sizeLine(savePlan(M, voices, everything(voices), 13_200, false, EXTRAS))).toBe("13 kB of text, plus 52 kB the voice needs offline. The voice is already on this device.");
  });

  it("saving counts toward its true total; saved states its bytes and the persistence answer", () => {
    expect(savingLine(48_200_000, 114_600_000)).toBe("Saving… 48.2 of 114.6 MB");
    expect(savingLine(200, 100)).toBe("Saving… 0.0 of 0.0 MB");
    const bytes = onDeviceBytes(M, voices, 17_000, EXTRAS);
    expect(bytes).toBe(17_000 + 92_400_000 + 5_000 + 21_600_000 + 522_000 + 2_100);
    expect(savedLine(bytes, true)).toBe("Plays in Dial with no connection. 114.5 MB on this device, the voice shared by every saved work.");
    expect(savedLine(bytes, false)).toContain("This browser may clear it if the device runs short of space.");
    expect(kilobytes(10)).toBe("1 kB");
  });

  it("offline copy is the spec's, and failures are plain words with the fix", () => {
    expect(OFFLINE_NOTICE).toBe("Offline. Works saved on this device play as usual. The others need a connection.");
    expect(WORK_NOT_ON_DEVICE).toMatch(/^This work isn't saved on this device\./);
    expect(saveFailedLine("QuotaExceededError: x")).toMatch(/no room on this device/);
    expect(saveFailedLine("TypeError: Failed to fetch")).toMatch(/Check your connection/);
    expect(saveFailedLine("Error: voice part model_quantized.part2: 503")).toMatch(/could not send/);
    expect(saveFailedLine("Error: ShellError: x")).toMatch(/could not keep its own page files on this device, so nothing was saved/);
  });

  it("Save for offline and Download as an audio file stay two labelled things", () => {
    const html = read("web/index.html");
    expect(html).toContain(">Download as an audio file</a>");
    expect(read("web/src/offline/ui.ts")).toContain('"Save for offline"');
    expect(html).not.toMatch(/Save for offline[^<]*download/i);
  });
});

describe("installing Dial", () => {
  const base: InstallInput = { listened: true, standalone: false, promptAvailable: false, iosSafari: false, notNowAt: null, now: Date.UTC(2026, 8, 26) };

  it("shows Install only where the browser offered the prompt, and only after a completed listen", () => {
    expect(installCard({ ...base, promptAvailable: true })).toBe("prompt");
    expect(installCard({ ...base, promptAvailable: true, listened: false })).toBeNull();
    expect(installCard(base)).toBeNull();
    expect(installCard({ ...base, promptAvailable: true, standalone: true })).toBeNull();
  });

  it("on iPhone and iPad Safari, the Home Screen steps instead, with no Install button", () => {
    expect(installCard({ ...base, iosSafari: true })).toBe("ios");
    const html = read("web/index.html");
    const ios = /<section class="card install" id="ios-card"[\s\S]*?<\/section>/.exec(html)![0];
    // The saved-works note starts hidden, and shows only where offline saving works.
    expect(ios).toContain('<p class="muted install-note" id="ios-saved-note" hidden>');
    expect(read("web/src/offline/ui.ts")).toContain('if (iosSaved) iosSaved.hidden = card !== "ios" || !(await offlineWorks());');
    expect(ios).not.toContain(">Install<");
    expect(ios).toContain("Scroll down and tap Add to Home Screen.");
    expect(ios).toContain("iPhone can clear saved works if you do not open Dial for a week");
    // Safari and a Home Screen app keep separate storage on iOS.
    expect(ios).toContain("Works you save in the Home Screen app stay with it. Works saved in Safari need saving again there.");
  });

  it("no card claims lock-screen controls (playback is Web Audio); Media Session is metadata and play/pause only", () => {
    expect(read("web/index.html")).not.toMatch(/lock-screen/i);
    const main = read("web/src/main.ts");
    expect(main).toContain('if (session === own && own.live && audio.state === "suspended") pause.click();');
    expect(main).toContain('if (session === own && own.live && audio.state === "running") pause.click();');
    expect(main).toMatch(/const offAir = \(\) => \{[\s\S]*?clearMediaSession\(\);[\s\S]*?\};/);
    expect(main).toContain("navigator.mediaSession.metadata = null;");
  });

  it("Not now hides it for 30 days", () => {
    const day = 86_400_000;
    expect(INSTALL_SNOOZE_DAYS).toBe(30);
    expect(installCard({ ...base, promptAvailable: true, notNowAt: base.now - 29 * day })).toBeNull();
    expect(installCard({ ...base, promptAvailable: true, notNowAt: base.now - 30 * day })).toBe("prompt");
  });

  it("detects iPhone and iPad Safari, not other iOS browsers", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(isIosSafari(iphone, 5)).toBe(true);
    expect(isIosSafari("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", 5)).toBe(true);
    expect(isIosSafari("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", 0)).toBe(false);
    expect(isIosSafari(iphone.replace("Version/18.0", "CriOS/130.0"), 5)).toBe(false);
  });
});

describe("the app manifest and icons", () => {
  const tokens = nightTokens(read("design/tokens.css"));

  it("takes its colours from tokens.css through the build: the template holds no colour of its own", () => {
    const template = read("web/public/manifest.webmanifest");
    expect(template).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/);
    const stamped = JSON.parse(stampTokens(template, tokens)) as Record<string, unknown>;
    expect(stamped.name).toBe("Dial");
    expect(stamped.short_name).toBe("Dial");
    expect(stamped.display).toBe("standalone");
    expect(stamped.theme_color).toBe(resolveHex(tokens, "--hex-walnut"));
    expect(stamped.background_color).toBe(stamped.theme_color);
    expect(read("web/index.html")).toContain('<meta name="theme-color" content="token(--color-bg)" />');
    expect(() => stampTokens("token(--no-such-token)", tokens)).toThrow(/does not resolve/);
  });

  it("the icons are the arch logomark, made at build time as SVG and PNG (never committed)", () => {
    const files = iconFiles(tokens);
    expect(files["dial.svg"]!.toString()).toContain("A52 52 0 0 1 112 62");
    for (const f of ["dial-192.png", "dial-512.png", "dial-maskable-512.png", "apple-touch-icon.png"]) {
      expect(files[f]!.subarray(1, 4).toString(), f).toBe("PNG");
    }
    expect(files["dial-512.png"]!.readUInt32BE(16)).toBe(512);
    expect(readdirSync(path.join(root, "web", "public")).filter((f) => /\.(png|svg)$/.test(f))).toEqual([]);
    const manifest = JSON.parse(read("web/public/manifest.webmanifest")) as { icons: { src: string; purpose?: string }[] };
    expect(manifest.icons.map((i) => i.src.replace("/icons/", ""))).toEqual(["dial.svg", "dial-192.png", "dial-512.png", "dial-maskable-512.png"]);
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("the build wrote the stamped manifest and icons into dist", () => {
    if (!existsSync(path.join(root, "dist", "manifest.webmanifest"))) return;
    const built = JSON.parse(readFileSync(path.join(root, "dist", "manifest.webmanifest"), "utf8")) as { theme_color: string };
    expect(built.theme_color).toBe(resolveHex(tokens, "--color-bg"));
    for (const f of ["dial.svg", "dial-192.png", "dial-512.png", "dial-maskable-512.png", "apple-touch-icon.png"]) expect(existsSync(path.join(root, "dist", "icons", f)), f).toBe(true);
    expect(readFileSync(path.join(root, "dist", "index.html"), "utf8")).toContain(`<meta name="theme-color" content="${built.theme_color}" />`);
  });
});

// Each real work's voice set under the casting rule, pinned per
// CAST_ENGINE_VERSION. A change to casting that changes any set must bump
// the version (so saved works show the new-version state), then pin here.
const CAST_PINS: Record<string, Record<string, string>> = {
  "1": { cave: "bm_george", crito: "bm_fable,bm_lewis", meditations: "bm_george" },
};

describe("CAST_ENGINE_VERSION follows the cast", () => {
  it("each real work's voice set matches the pin for this version (else: bump CAST_ENGINE_VERSION)", () => {
    const now: Record<string, string> = {};
    for (const w of WORKS) {
      const c = tryCast(segment(read(`web/public/works/${w.slug}.txt`)), w.cast);
      now[w.slug] = c ? workVoices(c.voices).join(",") : "(no cast)";
    }
    const pinned = CAST_PINS[CAST_ENGINE_VERSION];
    expect(pinned, `no voice-set pin for CAST_ENGINE_VERSION ${CAST_ENGINE_VERSION}: add one to tests/offline.test.ts`).toBeDefined();
    expect(now, "the cast output changed: bump CAST_ENGINE_VERSION in web/src/engine/cast.ts, then pin the new sets here").toEqual(pinned);
  });
});

describe("the offline-compatibility key", () => {
  const pins = { sha256: "m".repeat(64), runtimeSha256: "r".repeat(64), voices: { bm_george: "g", af_heart: "h" } };

  it("changes with any voice pin, the runtime pin or the casting rule's version, and not with key order", () => {
    const k = offlineKey(pins, "1")!;
    expect(k).toMatch(/^[0-9a-f]{8}$/);
    expect(offlineKey({ ...pins, voices: { af_heart: "h", bm_george: "g" } }, "1")).toBe(k);
    expect(offlineKey({ ...pins, voices: { ...pins.voices, am_michael: "n" } }, "1")).not.toBe(k);
    expect(offlineKey({ ...pins, voices: { ...pins.voices, bm_george: "g2" } }, "1")).not.toBe(k);
    expect(offlineKey({ ...pins, runtimeSha256: "s".repeat(64) }, "1")).not.toBe(k);
    expect(offlineKey({ ...pins, sha256: "n".repeat(64) }, "1")).not.toBe(k);
    expect(offlineKey(pins, "2")).not.toBe(k);
    expect(offlineKey(null, "1")).toBeNull();
    expect(pinsOf({ ...pins, repo: "r", sizes: {} })).toEqual(pins);
    expect(pinsOf({})).toBeNull();
  });

  it("the key is the saved data's: new page online with an old helper, and old helper offline with a newer saved manifest, are both the new-version state", () => {
    const plan = savePlan(M, ["bm_george"], everything(["bm_george"]), 17_000, true, []);
    const oldPins = pins;
    const newPins = { ...pins, voices: { ...pins.voices, am_michael: "n" } };
    const oldHelper = { ok: true, key: offlineKey(oldPins, "1") };
    // Online: the page read the site's (new) manifest; the helper is still the old build's.
    expect(savedState(plan, oldHelper, offlineKey(newPins, "1"))).toBe("older");
    // Offline: the old helper serves a saved manifest it refreshed to the new one.
    expect(savedState(plan, oldHelper, offlineKey(newPins, "1"))).toBe("older");
    // Same pins, but the casting rule moved on.
    expect(savedState(plan, oldHelper, offlineKey(oldPins, "2"))).toBe("older");
    // Matching data and helper.
    expect(savedState(plan, oldHelper, offlineKey(oldPins, "1"))).toBe("saved");
    const ui = read("web/src/offline/ui.ts");
    expect(ui).toContain("const saved = savedState(plan, await shellState(), offlineKey(pinsOf(manifest.manifest), CAST_ENGINE_VERSION));");
    expect(ui).not.toContain("PAGE_KEY");
  });

  it("the save announcement matches the row", () => {
    expect(saveEndLine("saved", "the Cave")).toBe("Saved the Cave for offline.");
    expect(saveEndLine("older", "the Cave")).toBe("Saved the Cave for the new version of Dial. Close every Dial tab, then reopen it with a connection.");
    expect(saveEndLine("no", "the Cave")).toBe("The Cave was not saved on this device.");
    expect(read("web/src/offline/ui.ts")).toContain('say(saveEndLine(end === "saved" ? "saved" : end === "older" ? "older" : "no", w.called));');
  });

  it("Saved only when the helper's key is the page's; otherwise the older-version state", () => {
    const plan = savePlan(M, ["bm_george"], everything(["bm_george"]), 17_000, true, []);
    expect(savedState(plan, { ok: true, key: "k1" }, "k1")).toBe("saved");
    expect(savedState(plan, { ok: true, key: "k0" }, "k1")).toBe("older");
    expect(savedState(plan, { ok: true, key: null }, "k1")).toBe("older");
    expect(savedState(plan, { ok: true, key: "k1" }, null)).toBe("older");
    expect(savedState(plan, { ok: false, key: "k1" }, "k1")).toBe("no");
    expect(SAVED_OLDER).toBe("Saved for the new version of Dial");
    expect(SAVED_OLDER_LINE).toBe("Close every Dial tab, then reopen it with a connection.");
  });

  it("the helper compiles its build's pins and casting version; the page compares it with the saved data's", () => {
    expect(CAST_ENGINE_VERSION).toMatch(/^\d+$/);
    const sw = read("web/src/sw.ts");
    expect(sw).toContain("const KEY = offlineKey(pinsOf(__VOICE_PINS__), CAST_ENGINE_VERSION);");
    expect(sw).toMatch(/port\.postMessage\(\{ type: "shell", ok, build: __BUILD_TAG__, key: KEY \}\)/);
    expect(read("scripts/build.mjs")).toContain("__VOICE_PINS__: JSON.stringify(pins)");
    const built = path.join(root, "dist", "sw.js");
    expect(existsSync(built), "dist/sw.js: run npm run build first").toBe(true);
    const m = JSON.parse(read("web/public/voice/manifest.json"));
    // The built helper carries this manifest's runtime pin.
    expect(readFileSync(built, "utf8")).toContain(m.runtimeSha256);
  });
});

describe("the contract checks the installable app and the offline helper", () => {
  it("every offline shell file is served: the build writes the list the helper compiles in", () => {
    const checks = (parseYaml(read("contract.yaml")) as { checks: { type: string; path?: string; expect?: number }[] }).checks;
    expect(checks.some((c) => c.type === "each_status" && c.path === "/offline-shell.json" && c.expect === 200)).toBe(true);
    const listed = JSON.parse(readFileSync(path.join(root, "dist", "offline-shell.json"), "utf8")) as string[];
    const compiled = /`(\/[^`]*)`\.split\(`,`\)/.exec(readFileSync(path.join(root, "dist", "sw.js"), "utf8"))![1]!.split(",");
    expect(listed).toEqual(compiled);
  });

  const checks = (parseYaml(read("contract.yaml")) as { checks: { type: string; path?: string; expect?: number }[] }).checks;
  it("/manifest.webmanifest and /sw.js return 200", () => {
    for (const p of ["/manifest.webmanifest", "/sw.js"]) {
      expect(checks.some((c) => c.type === "status" && c.path === p && c.expect === 200), p).toBe(true);
    }
  });
  it("the page registers the helper for the whole site from main.ts", () => {
    expect(read("web/src/main.ts")).toMatch(/^registerOfflineHelper\(\);$/m);
    expect(read("web/src/offline/store.ts")).toContain('navigator.serviceWorker.register("/sw.js", { scope: "/" })');
  });
});
