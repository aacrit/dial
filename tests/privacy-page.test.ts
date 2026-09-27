// The privacy page states what the product actually does (doctrine L-26).
// Each claim checked here is paired with the code or config that makes it
// true, so changing one without the other fails. When a product adds a
// surface that collects or sends anything, it adds the claim to
// web/privacy.html and its pairing here in the same change.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CSP } from "../scripts/lib/csp.mjs";
import { RETENTION_DAYS } from "../worker/src/config";
import { IDLE_SCENARIOS, runIdleScenario } from "./helpers/retention-sim";
import { parse as parseYaml } from "yaml";
import { RECORD_KEYS, serializeLog } from "../web/src/request-log";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const text = read("web/privacy.html").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const workerFiles = () => readdirSync(path.join(root, "worker/src")).filter((f) => f.endsWith(".ts"));

describe("web/privacy.html, claim by claim", () => {
  it("no anonymous id, cookie or analytics script: no client or Worker code sets one", () => {
    expect(text).toContain("There is no anonymous id, no cookie, and no third-party analytics script");
    expect(text).not.toMatch(/no local storage/);
    for (const dir of ["web/src", "worker/src"]) {
      for (const f of readdirSync(path.join(root, dir), { recursive: true, encoding: "utf8" }).filter((x) => x.endsWith(".ts"))) {
        expect(read(`${dir}/${f}`), f).not.toMatch(/\bindexedDB\b|document\.cookie|set-cookie/i);
      }
    }
    for (const page of readdirSync(path.join(root, "web")).filter((p) => p.endsWith(".html"))) {
      expect(read(`web/${page}`), page).not.toMatch(/googletagmanager|google-analytics|cloudflareinsights|plausible|posthog/i);
    }
  });

  it("what Dial keeps in the browser: two settings in local storage, the tab's request log in session storage, and nothing else", () => {
    expect(text).toContain("The counts switch: one setting in local storage, whether to send daily counts, written only when you change it.");
    expect(text).toContain("Besides the voice, saved works and page files described above, Dial keeps three small things, all on your device and never sent.");
    // T5b: which encoding of the prepared recording plays here, remembered only once discovered by a failed try (recording/source.ts rememberPlaybackFormat).
    expect(text).toContain("Which encoding of Dial's prepared recording plays in this browser: one setting in local storage, written only once trying the usual one fails, so it is not tried again.");
    expect(text).toContain("This tab's request log: the path, size and time of each request Dial's pages and their voice helpers made in this tab, of each request the offline helper made for this tab, and, marked as shared, of what the offline helper fetched for itself for every Dial tab (and, for a count, its name, and whether a send was not delivered), kept in session storage so the Seal widget on the radio can show it; never any text or audio, and erased when the tab closes.");
    // Per tab: the helper notes the page each request is for, sends each page only its own entries, and marks the rest shared.
    const sw = read("web/src/sw.ts");
    expect(sw).toContain('const client = event.clientId || event.resultingClientId || "";');
    expect(sw).toMatch(/for \(const \[id, list\] of own\) void clients\.get\(id\)\.then\(\(c\) => c\?\.postMessage\(\{ type: REQUESTS_MESSAGE, entries: list, shared: false \}\)\);/);
    expect(sw).toMatch(/c\.postMessage\(\{ type: REQUESTS_MESSAGE, entries: shared, shared: true \}\)/);
    // Every fetch the helper makes for a page is noted for that page first.
    for (const fn of ["fromShell", "page", "saved"]) {
      const body = sw.slice(sw.indexOf(`async function ${fn}(`), sw.indexOf("\n}\n", sw.indexOf(`async function ${fn}(`)));
      expect(body, fn).toMatch(/forPage\(request, client\);\s*(return await |return |const res = await )?fetch\(request\)/);
    }
    // The Seal widget's list marks the helper's shared rows on the row itself, and counts them apart in its totals.
    expect(read("web/src/request-log.ts")).toContain('"made by the offline helper, which every Dial tab shares"');
    expect(read("web/src/request-log.ts")).toContain("Offline helper, shared by every tab:");
    expect(read("web/src/seal-widget.ts")).toMatch(/tot\.innerHTML = totalsHtml\(s\);[\s\S]*rows\.innerHTML = html;/);
    // The voice helpers and the offline helper post their own record to the page, which records it.
    expect(read("web/src/sw.ts")).toMatch(/watchWorkerRequests\(tell\)/);
    expect(read("web/src/narrate.worker.ts")).toMatch(/watchWorkerRequests\(/);
    expect(read("web/src/request-recorder.ts")).toMatch(/recordEntries\(data\.entries\.filter\(isRawEntry\), data\.shared === true \? "shared" : "helper"\)/);
    const files = (readdirSync(path.join(root, "web/src"), { recursive: true, encoding: "utf8" }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => f.split(path.sep).join("/"));
    // localStorage is read and written in telemetry.ts (the counts switch) and recording/source.ts (T5b's remembered format) only, each under its own one key.
    const local = files.filter((f) => /\blocalStorage\b/.test(read(`web/src/${f}`)));
    expect(local.slice().sort()).toEqual(["recording/source.ts", "telemetry.ts"]);
    const telemetry = read("web/src/telemetry.ts");
    expect(telemetry).toContain('export const COUNTS_KEY = "dial.counts";');
    expect([...telemetry.matchAll(/\.setItem\(([^,]+),/g)].map((m) => m[1])).toEqual(["COUNTS_KEY"]);
    const recordingSource = read("web/src/recording/source.ts");
    expect(recordingSource).toContain('export const RECORDING_FORMAT_KEY = "dial.recording-format";');
    expect([...recordingSource.matchAll(/\.setItem\(([^,]+),/g)].map((m) => m[1])).toEqual(["RECORDING_FORMAT_KEY"]);
    // Written only when the listener changes it: setCounts is the one writer, called from the Seal widget's switch only.
    const setters = files.filter((f) => f !== "telemetry.ts" && /\bsetCounts\(/.test(read(`web/src/${f}`)));
    expect(setters).toEqual(["seal-widget.ts"]);
    expect(read("web/src/seal-widget.ts")).toMatch(/sw\.addEventListener\("click", \(\) => \{\s*const on = !countsOn\(\);\s*const kept = setCounts\(on\);/);
    // sessionStorage: request-recorder.ts only, under LOG_KEY, and only the record's own keys.
    const session = files.filter((f) => /\bsessionStorage\b/.test(read(`web/src/${f}`)));
    expect(session).toEqual(["request-recorder.ts"]);
    const recorder = read("web/src/request-recorder.ts");
    expect([...recorder.matchAll(/\.setItem\(([^,]+),\s*([^)]+\))/g)].map((m) => [m[1], m[2]])).toEqual([["LOG_KEY", "serializeLog(next)"]]);
    expect(RECORD_KEYS).toEqual(["t", "path", "own", "dir", "bytes", "served", "by", "event", "failed"]);
    const rec = { t: 1, path: "/e", own: true, dir: "sent" as const, bytes: 27, event: "page_view", text: "a line of the book", audio: [1, 2] };
    expect(Object.keys(JSON.parse(serializeLog({ records: [rec], dropped: 0 })).records[0])).toEqual(["t", "path", "own", "dir", "bytes", "event"]);
    // The request log is never sent: nothing that reads it posts anything.
    for (const f of files.filter((x) => /readLog\(|LOG_KEY/.test(read(`web/src/${x}`)))) {
      expect(read(`web/src/${f}`), f).not.toMatch(/\bfetch\(|sendEvent\(\s*[a-z]/);
    }
  });

  it("the counts switch: off means no count at all, feedback still goes; each count is named for what it counts", () => {
    expect(text).toContain("When it is off, this site sends no counts at all: no page view, no work tuned in and no listen (a work heard for at least four fifths of its length, made on this device or Dial's recording). A feedback message you choose to send still goes, because you sent it.");
    expect(text).not.toMatch(/finished listen/);
    expect(text).toContain("Once you have heard four fifths of a work, one listen is counted");
    // One wording on both pages (CoS decision D), paired with HEARD_SHARE = 0.8.
    expect(text).not.toMatch(/80%/);
    const seal = read("web/index.html").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(seal).toContain("The switch: totals per day of page views, works tuned in, and listens (a work heard for at least four fifths of its length, made on this device or Dial's recording), and nothing more.");
    expect(seal).not.toMatch(/works fully made|80%/);
    expect(read("web/index.html")).toContain('<span id="sw-l">Send anonymous counts</span>');
    expect(text).toContain('You can turn the counts off in the Seal widget on the radio, with the switch "Send anonymous counts".');
    // Paired with the code: the three counts the page sends, and chapter_rendered once per listen, when 80% is heard on either path (broadcast-state.ts countsAsListen; tests/recordings.test.ts).
    const sent = new Set<string>();
    for (const f of (readdirSync(path.join(root, "web/src"), { recursive: true, encoding: "utf8" }) as string[]).filter((x) => x.endsWith(".ts"))) {
      for (const m of read(`web/src/${f}`).matchAll(/sendEvent\("([a-z_]+)"\)/g)) sent.add(m[1]!);
    }
    expect([...sent].sort()).toEqual(["chapter_rendered", "page_view", "work_opened"]);
    const main0 = read("web/src/main.ts");
    const done = main0.slice(main0.indexOf('} else if (msg.type === "done") {'), main0.indexOf("sched.renderFinished();\n      } else {"));
    // Not at "all made": only a listen that has heard 80% counts (CoS decision A).
    expect(done).not.toMatch(/reportCoreSuccess|count\(/);
    expect([...main0.matchAll(/reportCoreSuccess\(\);/g)]).toHaveLength(1);
    expect(main0).toMatch(/if \(countsAsListen\(own\.heard, own\.strip\.total, own\.counted\)\) \{\s*own\.counted = true;\s*reportCoreSuccess\(\);/);
    // Paired with tests/seal.test.ts, which runs sendEvent with the switch off; the feedback form does not consult it.
    const main = read("web/src/main.ts");
    const feedback = main.slice(main.indexOf("function setupFeedback"));
    expect(feedback).toContain('fetch("/feedback"');
    expect(feedback).not.toMatch(/countsOn/);
  });

  it("the Seal widget sends and counts nothing; a setting the browser will not keep changes nothing, and the widget disables the switch and says so", () => {
    expect(text).toContain("The Seal widget itself sends nothing and counts nothing.");
    expect(text).not.toContain("The Seal itself sends no count, not even a page view.");
    expect(read("web/src/seal-widget.ts")).not.toMatch(/sendEvent|reportCoreSuccess|fetch\(|noteSend/);
    expect(text).toContain("If your browser will not let Dial keep the setting, the Seal widget disables the switch and says so; counts stay as they were.");
    // A refused write changes nothing (counts stay on), and the Seal disables the switch with the reason.
    expect(read("web/src/telemetry.ts")).toMatch(/store\.setItem\(COUNTS_KEY, on \? "on" : "off"\);\s*return true;\s*\} catch \{\s*return false;/);
    expect(read("web/src/telemetry.ts")).not.toMatch(/pageOnly/);
    expect(read("web/src/seal-widget.ts")).toMatch(/const refuse = \(\) => \{\s*sw\.disabled = true;\s*note\.textContent = STORAGE_REFUSED;/);
  });

  it("no speed test is offered until the radio's gauge (T7), so the page makes no claim about one; its engine still sends nothing", () => {
    // The Seal page and its test are gone (design/spec.md 00); the gauge that replaces it is T7's, with its own claim.
    expect(text).not.toMatch(/speed test/i);
    const files = (readdirSync(path.join(root, "web/src"), { recursive: true, encoding: "utf8" }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => f.split(path.sep).join("/"));
    const starters = files.filter((f) => /type: "bench"/.test(read(`web/src/${f}`)) && f !== "narrate.worker.ts");
    expect(starters).toEqual([]);
    const worker = read("web/src/narrate.worker.ts");
    const bench = worker.slice(worker.indexOf("async function bench("), worker.indexOf("ctx.onmessage"));
    expect(bench).toMatch(/await loadVoice\(/);
    for (const [f, src] of [["bench.ts", read("web/src/bench.ts")], ["narrate.worker.ts bench()", bench]]) expect(src, f).not.toMatch(/sendEvent|fetch\(|Storage\b|caches\.open|indexedDB/);
  });

  it("the narration is made on the device: the render worker only receives text and posts audio back, and the voice sits in cache storage", () => {
    expect(text).toContain("The words and the audio are never sent anywhere; the only things this page sends are the daily counts and any feedback you choose to send");
    expect(text).not.toMatch(/Nothing you listen to or render is sent|Nothing was sent anywhere/);
    // Paired with the allowlist every fetch in web/src is checked against (tests/no-network.test.ts).
    expect(JSON.parse(read("privacy-allowlist.json")).sends).toEqual(["/e", "/feedback"]);
    expect(text).toContain("kept in your browser's cache storage");
    const worker = read("web/src/narrate.worker.ts");
    expect(worker).not.toMatch(/\bfetch\(/);
    expect(read("web/src/voice.ts")).toMatch(/caches\.open\(/);
    // tests/no-network.test.ts checks every fetch in web/src against privacy-allowlist.json.
  });

  // T4: Save for offline. Its claims sit in their own section of the page.
  it("Save for offline keeps the text, the voice and the page files in cache storage, and saving sends nothing", async () => {
    expect(text).toContain(`"Save for offline" keeps a work's text, the voice it needs and this site's own page files in your browser's cache storage on this device`);
    expect(text).toContain("Saving only downloads this site's own files: nothing about what you save is sent.");
    const store = read("web/src/offline/store.ts");
    expect(store).toContain("await put(saved, workKey(slug), new Response(text");
    expect(store).toMatch(/await put\(kv, hfVoiceKey\(m\.repo, id\)/);
    expect(store).not.toMatch(/method:\s*"POST"|sendBeacon/);
    expect(read("web/src/sw.ts")).toContain("await cache.put(path, copy);");
    // Every fetch in store.ts is an allowlisted download (tests/no-network.test.ts, tests/offline.test.ts).
    expect(JSON.parse(read("privacy-allowlist.json")).sends).toEqual(["/e", "/feedback"]);
  });

  // T5: Dial's prepared recordings.
  it("a prepared recording is downloaded from this site as it plays, and kept only if the work is saved", () => {
    expect(text).toContain("A work with a recording Dial made in advance plays that recording. It is downloaded from this site, a part at a time as you listen, and Dial keeps it in its own storage only if you save the work for offline.");
    // Downloads only, from this origin: the allowlist names /recordings/, and sends stay the counts and feedback.
    const allow = JSON.parse(read("privacy-allowlist.json"));
    expect(allow.downloads).toContain("/recordings/");
    expect(allow.sends).toEqual(["/e", "/feedback"]);
    // Playing never stores: the Recording class (fetching, checking and decoding parts) keeps them in memory only.
    // T5b's remembered playback format, elsewhere in this file, is neither audio nor text nor a pin: see the local-storage test above.
    const source = read("web/src/recording/source.ts");
    const recordingClass = source.slice(source.indexOf("export class Recording"), source.indexOf("\n}\n", source.indexOf("export class Recording")) + 3);
    expect(recordingClass).not.toMatch(/caches\.|cache\.put|localStorage|indexedDB/);
    expect(source).toMatch(/fetch\(`\/recordings\/\$\{slug\}\/\$\{file\}`\)/);
    // Only Save for offline puts recording files in cache storage, and the offline helper only refreshes what is already there.
    const store = read("web/src/offline/store.ts");
    expect(store).toMatch(/export async function saveRecording[\s\S]*await put\(saved, f\.path, new Response\(buf/);
    expect(read("web/src/sw.ts")).toContain("const had = res.ok ? await cache.match(key) : undefined;");
  });

  it("nothing is made while a prepared recording plays; one listen is counted once 80% is heard", async () => {
    expect(text).toContain("Nothing is made on your device while it plays, and the words and the audio are never sent anywhere. Once you have heard four fifths of a work, one listen is counted");
    const main = read("web/src/main.ts");
    // No render worker for a prepared recording.
    expect(main).toContain('const worker = rec ? null : new Worker(new URL("./narrate.worker.ts", import.meta.url), { type: "module" });');
    const { HEARD_SHARE } = await import("../web/src/broadcast-state");
    expect(HEARD_SHARE).toBe(0.8);
  });

  it("the core shell (about 0.6 MB) is kept for every visitor, the rest on a save, and the model and runtime stay after the last Remove", () => {
    expect(text).toContain("The offline helper also keeps this site's page files (about 0.6 MB: the pages, their main script and styles, the fonts' Latin faces and the icons) in cache storage for every visitor");
    expect(text).toContain("When you save a work it keeps the rest of the page files too (about 2.5 MB more, mostly the script that makes speech on this device).");
    expect(text).toContain("The voice model and its runtime stay after the last Remove");
    // Registered on every page load, not on the first save.
    expect(read("web/src/main.ts")).toMatch(/^registerOfflineHelper\(\);$/m);
    const store = read("web/src/offline/store.ts");
    expect(store.slice(store.indexOf("export async function removeWork"))).not.toMatch(/voiceCacheName|runtimeCacheName/);
    // "about 0.6 MB" and "2.5 MB more" are the built shells' sizes (tests/offline.test.ts computes them from dist/).
  });

  it("the offline helper never stores the daily counts or feedback", async () => {
    expect(text).toContain("It never stores the daily counts or feedback, and it sends nothing of its own. It tells Dial's open pages which requests it made, on this device only, so the Seal widget on the radio can list them.");
    // Its only messages go to this origin's own window clients.
    const sw = read("web/src/sw.ts");
    expect(sw).toMatch(/matchAll\(\{ type: "window", includeUncontrolled: true \}\)/);
    const { route } = await import("../web/src/offline/routes");
    const origin = "https://dial.voidvision.org";
    for (const p of ["/e", "/feedback"]) for (const m of ["GET", "POST"]) expect(route(new URL(p, origin), m, origin)).toBe("ignore");
  });

  it("Remove deletes the work's text and any voice no other saved work uses; the model stays", async () => {
    expect(text).toContain("Remove deletes that work's text, its saved recording, and any voice no other saved work uses. The voice model stays, because every work uses it");
    const { voicesToRemove } = await import("../web/src/offline/plan");
    const saved = new Map([["cave", ["bm_george"]], ["crito", ["bm_george", "bm_fable"]]]);
    expect(voicesToRemove("crito", saved, saved)).toEqual(["bm_fable"]);
    const store = read("web/src/offline/store.ts");
    expect(store).toMatch(/const records = await savedVoiceRecords\(\);[\s\S]*await cache\.delete\(workKey\(slug\)\);[\s\S]*for \(const id of voicesToRemove\(slug, records, todayCasts\)\) await kv\.delete/);
    expect(store.slice(store.indexOf("export async function removeWork"))).not.toMatch(/voiceCacheName|runtimeCacheName/);
  });

  it("persistent storage is asked for on the first save, and a refusal is stated where it applies", async () => {
    expect(text).toContain("On the first save, Dial asks the browser to keep saved works (persistent storage); if the browser declines, it may clear them when the device runs short of space.");
    expect(text).toContain("On iPhone and iPad, in a Safari tab, saved works can be cleared if you do not open Dial for a week.");
    expect(read("web/src/offline/store.ts")).toContain("return await s.persist();");
    expect(read("web/src/offline/ui.ts")).toMatch(/if \(firstSave\) await requestPersistence\(\);/);
    const { savedLine } = await import("../web/src/offline/plan");
    expect(savedLine(1, false)).toContain("may clear it if the device runs short of space");
  });

  it("Not now on the install card is kept in cache storage for 30 days and never sent", async () => {
    expect(text).toContain("that date is kept in the same cache storage so the card stays hidden for 30 days. It is never sent.");
    const install = read("web/src/offline/install.ts");
    expect(install).toMatch(/await \(await caches\.open\(DEVICE_CACHE\)\)\.put\(NOT_NOW_KEY/);
    expect(install).not.toMatch(/fetch\(/);
    const { INSTALL_SNOOZE_DAYS } = await import("../web/src/offline/install");
    expect(INSTALL_SNOOZE_DAYS).toBe(30);
  });

  it("counts as daily totals: /e takes exactly one field and only increments a day count", () => {
    expect(text).toContain("counts how many times a small set of named events happen each day");
    expect(read("worker/src/index.ts")).toContain('keys.length !== 1 || keys[0] !== "name"');
    expect(read("migrations/0001_events.sql")).toMatch(/CREATE TABLE IF NOT EXISTS event_counts \(\s*day TEXT NOT NULL,\s*name TEXT NOT NULL,\s*count INTEGER/);
  });

  it("feedback is the text, the page and the arrival time: the feedback table holds exactly that", () => {
    expect(text).toContain("the server stores them with the time the message arrived");
    const cols = read("migrations/0001_events.sql").match(/CREATE TABLE IF NOT EXISTS feedback \(([\s\S]*?)\);/)![1];
    expect(cols.split(",").map((c) => c.trim().split(/\s+/)[0])).toEqual(["id", "text", "page", "ts"]);
  });

  it("nothing is loaded from another company: the CSP allows this origin only", () => {
    expect(text).toContain("nothing is loaded from another company");
    expect(CSP).not.toMatch(/https?:/);
  });

  it("the IP is used for the rate limit only, IPv6 by its network part, and only the guard reads it", () => {
    expect(text).toContain("for an IPv6 address, only its network part");
    expect(text).toContain("Cloudflare keeps a short-lived count in memory");
    const guard = read("worker/src/guard.ts");
    expect(guard).toContain('request.headers.get("cf-connecting-ip")');
    expect(guard).toContain("::/64");
    for (const f of workerFiles().filter((x) => x !== "guard.ts")) {
      expect(read(`worker/src/${f}`), f).not.toMatch(/cf-connecting-ip|x-forwarded-for|x-real-ip/i);
    }
  });

  it("per-request logs are off and the product's code logs nothing: wrangler.jsonc, and no console call in the Worker", () => {
    expect(text).toContain("Cloudflare's per-request logs are turned off for this site");
    expect(read("wrangler.jsonc")).toMatch(/"invocation_logs": false/);
    expect(read("wrangler.jsonc")).toMatch(/"redact_query_string": true/);
    for (const f of workerFiles()) expect(read(`worker/src/${f}`), f).not.toMatch(/console\./);
  });

  it("deleted automatically in batches on days the site is used: the daily purge and the purge before each insert both exist", () => {
    const index = read("worker/src/index.ts");
    expect(index).toMatch(/if \(count === 1\) \{\s*await purgeOldFeedback\(env\.DB, now, dailyPurgeLimit\(env\)\);/);
    expect(index).toMatch(/await purgeOldFeedback\(env\.DB, now, FEEDBACK_PURGE_ON_INSERT\);\s*await env\.DB\.prepare\("INSERT INTO feedback/);
  });

  it("the one request log is the WAF's: the page names its threshold and what it records, matching contract.yaml's zone_waf_rule", () => {
    expect(text).toContain("keeps no log of ordinary requests");
    expect(text).toContain("one IP address sends more than 30 requests to voidvision.org sites in 10 seconds, Cloudflare's firewall blocks it for 10 seconds");
    expect(text).toContain("the IP address, the page asked for and the browser's user agent");
    const rule = parseYaml(read("contract.yaml")).zone_waf_rule;
    expect(rule).toMatchObject({ requests: 30, period_seconds: 10, action: "block", mitigation_timeout_seconds: 10 });
    expect(rule.logs_blocked_requests).toEqual(["ip", "path", "user_agent"]);
  });

  it("feedback is deleted after 90 days on days the site is used; after unvisited stretches deletion falls behind and catches up (SQLite simulations)", async () => {
    expect(text).toContain(`Feedback text is kept for ${RETENTION_DAYS} days, then deleted automatically in batches on days the site is used.`);
    expect(text).toContain("If the site goes unvisited for a while, deletion falls behind and catches up once visits resume.");
    expect(text).not.toMatch(/within a day|plus one|as many days/);
    // Paired with the behavior: in every visit pattern the backlog exists
    // (falls behind), then shrinks to zero once visits are daily (catches up).
    for (const scenario of IDLE_SCENARIOS) {
      const r = await runIdleScenario(scenario);
      expect(r.backlog, scenario.name).toBeGreaterThan(0);
      expect(r.clearedWithinVisitedDays, scenario.name).toBeLessThan(Infinity);
    }
  }, 240_000);

  it("the restore window is 7 days: D1 Time Travel on the Workers free plan (30 days is the paid plan)", () => {
    // developers.cloudflare.com/d1/platform/limits: Time Travel is 7 days on
    // Workers Free and 30 on Workers Paid. This product runs on the free tier.
    expect(text).toContain("any moment in the last 7 days");
    // Scoped to the restore sentence: other claims (the install card's 30 days) may name 30 days.
    const restore = /Cloudflare D1, the database Dial uses,[^.]*\.[^.]*\./.exec(text)?.[0] ?? "";
    expect(restore).toContain("7 days");
    expect(restore).not.toMatch(/(30|thirty) days/i);
  });
});
