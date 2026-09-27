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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const text = read("web/privacy.html").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const workerFiles = () => readdirSync(path.join(root, "worker/src")).filter((f) => f.endsWith(".ts"));

describe("web/privacy.html, claim by claim", () => {
  it("no anonymous id, cookie or local storage: no client or Worker code sets one", () => {
    expect(text).toContain("There is no anonymous id, no cookie, no local storage, and no third-party analytics script");
    for (const dir of ["web/src", "worker/src"]) {
      for (const f of readdirSync(path.join(root, dir)).filter((x) => x.endsWith(".ts"))) {
        expect(read(`${dir}/${f}`), f).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\.|document\.cookie|set-cookie/i);
      }
    }
    for (const page of readdirSync(path.join(root, "web")).filter((p) => p.endsWith(".html"))) {
      expect(read(`web/${page}`), page).not.toMatch(/googletagmanager|google-analytics|cloudflareinsights|plausible|posthog/i);
    }
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

  it("the shell (about 3 MB) is kept for every visitor, and the model and runtime stay after the last Remove", () => {
    expect(text).toContain("The offline helper also keeps this site's page files (about 3 MB: the pages, scripts, styles, fonts and icons) in cache storage for every visitor");
    expect(text).toContain("The voice model and its runtime stay after the last Remove");
    // Registered on every page load, not on the first save.
    expect(read("web/src/main.ts")).toMatch(/^registerOfflineHelper\(\);$/m);
    const store = read("web/src/offline/store.ts");
    expect(store.slice(store.indexOf("export async function removeWork"))).not.toMatch(/voiceCacheName|runtimeCacheName/);
    // "about 3 MB" is the built shell's size (tests/offline.test.ts computes it from dist/).
  });

  it("the offline helper never stores the daily counts or feedback", async () => {
    expect(text).toContain("It never stores the daily counts or feedback, and it sends nothing of its own.");
    const { route } = await import("../web/src/offline/routes");
    const origin = "https://dial.voidvision.org";
    for (const p of ["/e", "/feedback"]) for (const m of ["GET", "POST"]) expect(route(new URL(p, origin), m, origin)).toBe("ignore");
  });

  it("Remove deletes the work's text and any voice no other saved work uses; the model stays", async () => {
    expect(text).toContain("Remove deletes that work's text and any voice no other saved work uses. The voice model stays, because every work uses it");
    const { voicesToRemove } = await import("../web/src/offline/plan");
    const saved = new Map([["cave", ["bm_george"]], ["crito", ["bm_george", "bm_fable"]]]);
    expect(voicesToRemove("crito", saved)).toEqual(["bm_fable"]);
    const store = read("web/src/offline/store.ts");
    expect(store).toMatch(/const records = await savedVoiceRecords\(\);[\s\S]*await cache\.delete\(workKey\(slug\)\);[\s\S]*for \(const id of voicesToRemove\(slug, records\)\) await kv\.delete/);
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
