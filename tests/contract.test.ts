import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NOT_APPLICABLE, USER_AGENT, burstBase, contractFetch, describeFetchError, isLocalUrl, loadContract, onHost, runContract } from "../scripts/contract.mjs";
import { contractAt, deployedTag } from "../scripts/deployed-contract.mjs";

let server: Server;
let baseUrl: string;

const GOOD_HOME = `<!doctype html><html><head><meta name="build" content="abc123"></head><body>Demo Product</body></html>`;
const BAD_HOME = `<!doctype html><html><head></head><body>Demo Product TODO fix this</body></html>`;

let currentHome = GOOD_HOME;
let currentFrameHeader = "DENY";
const postBodies: string[] = [];
const seenAgents: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/waf") {
      // A WAF-style block: 429 with Cloudflare's HTML page and a Retry-After.
      res.writeHead(429, { "content-type": "text/html", "retry-after": "10" });
      res.end("<html><title>Error 1015</title>You are being rate limited</html>");
      return;
    }
    if (req.url === "/worker-limited") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "10" });
      res.end(JSON.stringify({ error: "rate_limited" }));
      return;
    }
    if (req.url === "/list-ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(["/", "/healthz"]));
      return;
    }
    if (req.url === "/list-bad") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(["/", "/waf"]));
      return;
    }
    if (req.url === "/post-limited") {
      // A write path: refuses anything but POST, answers 400 to the first two, then the Worker's 429.
      if (req.method !== "POST" || req.headers["content-type"] !== "application/json") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        postBodies.push(body);
        const limited = postBodies.length > 2;
        res.writeHead(limited ? 429 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: limited ? "rate_limited" : "event_not_allowed" }));
      });
      return;
    }
    if (req.url === "/moved") {
      res.writeHead(301, { location: "https://dial.voidvision.org/moved" });
      res.end();
      return;
    }
    if (req.url === "/ua") {
      seenAgents.push(String(req.headers["user-agent"]));
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, build: "abc123" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "x-frame-options": currentFrameHeader });
    res.end(currentHome);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address && typeof address === "object") {
    baseUrl = `http://127.0.0.1:${address.port}`;
  } else {
    throw new Error("failed to determine test server address");
  }
});

afterAll(() => {
  server.close();
});

const contract = {
  checks: [
    { name: "status", type: "status", path: "/", expect: 200 },
    { name: "contains", type: "contains", path: "/", text: "Demo Product" },
    { name: "meta", type: "meta", path: "/", meta_name: "build" },
    { name: "healthz status", type: "status", path: "/healthz", expect: 200 },
    { name: "healthz ok", type: "json", path: "/healthz", field: "ok", expect: true },
    { name: "forbidden", type: "forbidden", path: "/", strings: ["undefined", "NaN", "lorem", "TODO"] },
    { name: "header exact", type: "header", path: "/", header: "X-Frame-Options", expect: "DENY" },
    { name: "header contains", type: "header", path: "/", header: "content-type", contains: "text/html" },
  ],
};

describe("contract runner", () => {
  it("passes every check against a healthy page", async () => {
    currentHome = GOOD_HOME;
    const results = await runContract(contract, baseUrl);
    expect(results.filter((r) => !r.pass)).toEqual([]);
  });

  it("fails the forbidden-string check when a placeholder leaks onto the page", async () => {
    currentHome = BAD_HOME;
    const results = await runContract(contract, baseUrl);
    expect(results.find((r) => r.label === "forbidden")?.pass).toBe(false);
    currentHome = GOOD_HOME;
  });

  it("fails a header check when the header is wrong or missing", async () => {
    currentFrameHeader = "SAMEORIGIN";
    const results = await runContract(contract, baseUrl);
    const exact = results.find((r) => r.label === "header exact");
    expect(exact?.pass).toBe(false);
    expect(exact?.detail).toContain('expected "DENY", got "SAMEORIGIN"');
    const missing = await runContract({ checks: [{ name: "m", type: "header", path: "/", header: "referrer-policy", expect: "no-referrer" }] }, baseUrl);
    expect(missing[0].pass).toBe(false);
    currentFrameHeader = "DENY";
  });
});

describe("contract runner: each_status", () => {
  it("passes when every listed path answers the status, and names each one that does not", async () => {
    const [ok] = await runContract({ checks: [{ name: "each", type: "each_status", path: "/list-ok", expect: 200 }] }, baseUrl);
    expect(ok.pass).toBe(true);
    const [bad] = await runContract({ checks: [{ name: "each", type: "each_status", path: "/list-bad", expect: 200 }] }, baseUrl);
    expect(bad.pass).toBe(false);
    expect(bad.detail).toBe("not 200: /waf 429");
  });
});

describe("contract runner: deployed-only burst checks", () => {
  it("skips a requires: deployed check against a local URL, reported as skipped, not failed", async () => {
    const results = await runContract({ checks: [{ name: "burst", type: "burst", path: "/", count: 3, expect_status: 429, requires: "deployed" }] }, baseUrl);
    expect(results[0]).toMatchObject({ pass: true, skipped: true, detail: "skipped: needs deployed runtime" });
  });

  it("isLocalUrl knows local dev hosts from deployed ones", () => {
    expect(isLocalUrl("http://127.0.0.1:8787")).toBe(true);
    expect(isLocalUrl("http://localhost:5173")).toBe(true);
    expect(isLocalUrl("https://product.voidvision.org")).toBe(false);
    expect(isLocalUrl("https://preview.product.workers.dev")).toBe(false);
  });

  it("a WAF-style 429 (HTML 1015 page) does not pass a check that expects the Worker's rate_limited body", async () => {
    const check = { name: "burst", type: "burst", path: "/waf", count: 3, expect_status: 429, expect_error: "rate_limited" };
    const [waf] = await runContract({ checks: [check] }, baseUrl);
    expect(waf.pass).toBe(false);
    expect(waf.detail).toContain('no 429 with {"error":"rate_limited"} in 3 requests');
    const [worker] = await runContract({ checks: [{ ...check, path: "/worker-limited" }] }, baseUrl);
    expect(worker.pass).toBe(true);
  });

  it("a burst check with concurrency sends every request, in waves", async () => {
    const results = await runContract({ checks: [{ name: "burst", type: "burst", path: "/", count: 7, concurrency: 3, expect_status: 429 }] }, baseUrl);
    expect(results[0]!.pass).toBe(false);
    expect(results[0]!.detail).toContain("in 7 requests");
  });

  it("a burst check fails when no request is refused", async () => {
    const results = await runContract({ checks: [{ name: "burst", type: "burst", path: "/", count: 3, expect_status: 429 }] }, baseUrl);
    expect(results[0].pass).toBe(false);
    expect(results[0].detail).toContain("no 429 in 3 requests");
  });

  it("pause_before_seconds waits before the check runs", async () => {
    const started = Date.now();
    await runContract({ checks: [{ name: "p", type: "status", path: "/", expect: 200, pause_before_seconds: 0.2 }] }, baseUrl);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it("contract.yaml's burst check is deployed-only, waits out the WAF window, and requires the Worker's body", () => {
    const file = fileURLToPath(new URL("../contract.yaml", import.meta.url));
    const burst = loadContract(path.resolve(file)).checks.find((c: { type: string }) => c.type === "burst");
    expect(burst).toMatchObject({ expect_status: 429, expect_error: "rate_limited", requires: "deployed" });
    expect(burst.pause_before_seconds).toBeGreaterThan(10);
    expect(burst.count).toBeGreaterThan(20);
  });

  it("on the production domain a burst goes to the workers.dev host, past the zone's WAF; any other base is kept", async () => {
    const contract = { burst_zone: "voidvision.org", burst_host: "https://dial.aacrit.workers.dev", checks: [] };
    expect(burstBase(contract, "https://dial.voidvision.org")).toBe("https://dial.aacrit.workers.dev");
    expect(burstBase(contract, "https://4e5f171d-dial.aacrit.workers.dev")).toBe("https://4e5f171d-dial.aacrit.workers.dev");
    expect(burstBase(contract, "http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(burstBase(contract, "https://voidvision.org.evil.example")).toBe("https://voidvision.org.evil.example");
    expect(burstBase({ checks: [] }, "https://dial.voidvision.org")).toBe("https://dial.voidvision.org");
  });

  it("runContract sends only bursts to the burst host; every other check stays on the base", async () => {
    // A burst_zone matching the local test host proves the routing without leaving the machine.
    let otherBuild = "abc123";
    let bursts = 0;
    const other = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, build: otherBuild }));
        return;
      }
      bursts++;
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":"rate_limited"}');
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const port = (other.address() as { port: number }).port;
    try {
      const contract = {
        burst_zone: "localhost",
        burst_host: `http://127.0.0.1:${port}`,
        checks: [
          { name: "home", type: "status", path: "/", expect: 200 },
          { name: "burst", type: "burst", path: "/", count: 2, expect_status: 429, expect_error: "rate_limited" },
        ],
      };
      const local = baseUrl.replace("127.0.0.1", "localhost");
      const [home, burst] = await runContract(contract, local);
      expect(home.pass).toBe(true);
      expect(home.detail).toBeUndefined();
      expect(burst.pass).toBe(true);
      // The result says where the burst ran: the summary names the base, and it did not run there.
      expect(burst.detail).toBe(`via http://127.0.0.1:${port}`);
      // The burst stops at the first refusal: one wave of one request was enough.
      expect(bursts).toBe(1);

      // A burst host serving another build is not the production Worker: the burst fails, and nothing is sent.
      otherBuild = "release/older";
      bursts = 0;
      const [, stale] = await runContract(contract, local);
      expect(stale.pass).toBe(false);
      expect(stale.detail).toBe(`burst_host http://127.0.0.1:${port} serves release/older, ${local} serves abc123; via http://127.0.0.1:${port}`);
      expect(bursts).toBe(0);
    } finally {
      other.close();
    }
  });

  it("host_suffix is judged on the URL the contract ran against, never on a rerouted burst host", async () => {
    // The base is under burst_zone but not under host_suffix; the burst host is under host_suffix.
    // Judged on the burst host, the check would run (and fetch); judged on the base, it is n/a.
    const contract = {
      burst_zone: "localhost",
      burst_host: "https://unused.voidvision.org",
      checks: [{ name: "zone-only burst", type: "burst", path: "/", count: 1, expect_status: 429, host_suffix: "voidvision.org" }],
    };
    const [r] = await runContract(contract, baseUrl.replace("127.0.0.1", "localhost"));
    expect(r).toMatchObject({ notApplicable: true, detail: NOT_APPLICABLE });
  });

  it("contract.yaml routes production bursts to this Worker's workers.dev host", () => {
    const file = fileURLToPath(new URL("../contract.yaml", import.meta.url));
    const c = loadContract(path.resolve(file));
    expect(c.burst_zone).toBe("voidvision.org");
    expect(c.burst_host).toBe("https://dial.aacrit.workers.dev");
    expect(burstBase(c, c.url)).toBe("https://dial.aacrit.workers.dev");
  });

  it("a burst with method and body posts JSON, and passes once the Worker's 429 answers", async () => {
    postBodies.length = 0;
    const [r] = await runContract({ checks: [{ name: "post burst", type: "burst", path: "/post-limited", method: "POST", body: { name: "not_an_event" }, count: 4, concurrency: 2, expect_status: 429, expect_error: "rate_limited" }] }, baseUrl);
    expect(r.pass).toBe(true);
    expect(postBodies).toEqual(Array(4).fill('{"name":"not_an_event"}'));
  });

  it("contract.yaml bursts the write paths with bodies validation refuses, so nothing is counted or stored", () => {
    const file = fileURLToPath(new URL("../contract.yaml", import.meta.url));
    const bursts = loadContract(path.resolve(file)).checks.filter((c: { type: string }) => c.type === "burst");
    const e = bursts.find((c: { path: string }) => c.path === "/e");
    const fb = bursts.find((c: { path: string }) => c.path === "/feedback");
    expect(e).toMatchObject({ method: "POST", body: { name: "not_an_event" }, expect_error: "rate_limited", requires: "deployed" });
    expect(fb).toMatchObject({ method: "POST", body: { text: "" }, expect_error: "rate_limited", requires: "deployed" });
    // Past each binding's limit (6 and 2 a minute), within one WAF window of 30.
    expect(e.count).toBeGreaterThan(6);
    expect(fb.count).toBeGreaterThan(2);
    expect(e.concurrency).toBeLessThan(30);
    expect(fb.concurrency).toBeLessThan(30);
  });
});

describe("verify-production checks the deployed release's contract, not main's", () => {
  it("reads the release tag from /healthz, and refuses a build that is not one", () => {
    expect(deployedTag({ ok: true, build: "release/2026.09.26-2" })).toBe("release/2026.09.26-2");
    expect(() => deployedTag({ ok: true, build: "a9ee601" })).toThrow(/not a release tag/);
    expect(() => deployedTag({ ok: true, build: "dev" })).toThrow(/not a release tag/);
    expect(() => deployedTag({ ok: true })).toThrow(/names no build/);
    expect(() => deployedTag(null)).toThrow(/names no build/);
    // A tag name is never passed to git unchecked.
    expect(() => contractAt("release/x; rm -rf /")).toThrow(/not a release tag/);
  });

  it("reads contract.yaml as it was at the tag, not as it is now", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dial-deployed-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
      git("init", "-q");
      writeFileSync(path.join(dir, "contract.yaml"), "checks: [released]\n");
      git("add", "contract.yaml");
      git("commit", "-q", "-m", "release");
      git("tag", "release/2026.09.26-2");
      writeFileSync(path.join(dir, "contract.yaml"), "checks: [main]\n");
      git("commit", "-q", "-am", "main moves on");
      expect(contractAt("release/2026.09.26-2", dir)).toBe("checks: [released]\n");
      expect(() => contractAt("release/2026.09.27-9", dir)).toThrow(/not in this checkout/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the workflow fetches the tags, runs that contract with main's runner, and creates its label before opening an issue", () => {
    const wf = readFileSync(fileURLToPath(new URL("../.github/workflows/verify-production.yml", import.meta.url)), "utf8");
    expect(wf).toMatch(/fetch-depth: 0/);
    expect(wf).toContain('node scripts/deployed-contract.mjs --url https://dial.voidvision.org --out "$RUNNER_TEMP/deployed-contract.yaml"');
    expect(wf).toContain('npm run contract -- --url https://dial.voidvision.org --contract "$RUNNER_TEMP/deployed-contract.yaml"');
    expect(wf.indexOf("gh label create prod-red")).toBeGreaterThan(0);
    expect(wf.indexOf("gh label create prod-red")).toBeLessThan(wf.indexOf("gh issue create"));
    expect(wf).not.toMatch(/continue-on-error|\|\|\s*true/);
  });
});

describe("http:// must redirect to https:// (CoS decision I)", () => {
  it("a redirect check passes on a 301 to https, fails on a 200, and a failing check names what it waits on", async () => {
    const check = { name: "r", type: "redirect", path: "/moved", scheme: "http", expect: 301, location_starts_with: "https://", failure_note: "Waiting on the founder." };
    const [ok] = await runContract({ checks: [check] }, baseUrl);
    expect(ok.pass).toBe(true);
    const [served] = await runContract({ checks: [{ ...check, path: "/" }] }, baseUrl);
    expect(served.pass).toBe(false);
    expect(served.detail).toMatch(/answered 200, expected 301 to https:\/\/\. Waiting on the founder\.$/);
  });

  const yamlCheck = () => loadContract(path.resolve(fileURLToPath(new URL("../contract.yaml", import.meta.url)))).checks.find((x: { type: string }) => x.type === "redirect");

  it("the check is left out on a workers.dev preview and on localhost, reported exactly 'n/a (production host only)', never failed or skipped", async () => {
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (u: string | URL) => {
      fetched.push(String(u));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      for (const base of ["https://dial.aacrit.workers.dev", "https://abc123-dial.aacrit.workers.dev", baseUrl, "https://voidvision.org.evil.example"]) {
        const [r] = await runContract({ checks: [yamlCheck()] }, base);
        expect(r, base).toMatchObject({ pass: true, notApplicable: true, detail: "n/a (production host only)" });
        expect(r.skipped, base).toBeUndefined();
      }
      expect(fetched).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(NOT_APPLICABLE).toBe("n/a (production host only)");
  });

  it("the check runs on dial.voidvision.org, over http, not following the redirect", async () => {
    const realFetch = globalThis.fetch;
    const calls: [string, RequestInit | undefined][] = [];
    let answer = new Response(null, { status: 301, headers: { location: "https://dial.voidvision.org/" } });
    globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
      calls.push([String(u), init]);
      return answer;
    }) as typeof fetch;
    try {
      const [ok] = await runContract({ checks: [yamlCheck()] }, "https://dial.voidvision.org");
      expect(ok.pass).toBe(true);
      expect(ok.notApplicable).toBeUndefined();
      expect(calls[0]![0]).toBe("http://dial.voidvision.org/");
      expect(calls[0]![1]?.redirect).toBe("manual");
      answer = new Response("page", { status: 200 });
      const [bad] = await runContract({ checks: [yamlCheck()] }, "https://dial.voidvision.org");
      expect(bad.pass).toBe(false);
      expect(bad.detail).toMatch(/answered 200, expected 301 to https:\/\/\. Waiting on the founder/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(onHost("https://dial.voidvision.org", "voidvision.org")).toBe(true);
    expect(onHost("https://voidvision.org", "voidvision.org")).toBe(true);
    expect(onHost("https://notvoidvision.org", "voidvision.org")).toBe(false);
  });

  it("contract.yaml limits it to the production zone's host, over http, and names the Board ask when it fails", () => {
    const c = yamlCheck();
    expect(c).toMatchObject({ path: "/", scheme: "http", expect: 301, location_starts_with: "https://", host_suffix: "voidvision.org" });
    expect(c.failure_note).toMatch(/Always Use HTTPS/);
    expect(c.failure_note).toMatch(/Board ask/);
    expect(c.failure_note).toMatch(/G3/);
  });
});

describe("contract runner: requests that fail below HTTP", () => {
  it("every request names itself with the runner's User-Agent", async () => {
    seenAgents.length = 0;
    const [r] = await runContract({ checks: [{ name: "ua", type: "status", path: "/ua", expect: 200 }] }, baseUrl);
    expect(r.pass).toBe(true);
    expect(seenAgents).toEqual([USER_AGENT]);
    expect(USER_AGENT).toMatch(/^dial-contract\/\d+ \(\+https:\/\/dial\.voidvision\.org\/privacy\)$/);
  });

  it("says why a fetch failed (DNS, refused), not only undici's 'fetch failed'", async () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND dial.voidvision.org"), { code: "ENOTFOUND" }) });
    expect(describeFetchError(err)).toBe("fetch failed: ENOTFOUND: getaddrinfo ENOTFOUND dial.voidvision.org");
    expect(describeFetchError(new Error("plain"))).toBe("plain");
    // A closed port: the check fails with the reason in its detail.
    const spare = createServer();
    await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
    const port = (spare.address() as { port: number }).port;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
    const [r] = await runContract({ checks: [{ name: "closed", type: "status", path: "/", expect: 200 }] }, `http://127.0.0.1:${port}`);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/failed: fetch failed: ECONNREFUSED/);
  }, 15_000);

  it("retries once after a failure below HTTP, and never retries an HTTP answer", async () => {
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return new Response("ok", { status: 503 });
    }) as typeof fetch;
    try {
      const res = await contractFetch("https://example.invalid/", {}, 1);
      expect(res.status).toBe(503);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("contract runner: burst pacing (T12)", () => {
  it("wave_gap_ms pauses between waves, and a burst stops at its first refusal", async () => {
    let n = 0;
    const times: number[] = [];
    const srv = createServer((_req, res) => {
      n++;
      times.push(Date.now());
      const limited = n > 4;
      res.writeHead(limited ? 429 : 200, { "content-type": "application/json" });
      res.end(limited ? '{"error":"rate_limited"}' : "{}");
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as { port: number }).port;
    try {
      const [r] = await runContract({ checks: [{ name: "b", type: "burst", path: "/", count: 40, concurrency: 2, wave_gap_ms: 150, expect_status: 429, expect_error: "rate_limited" }] }, `http://127.0.0.1:${port}`);
      expect(r.pass).toBe(true);
      // Waves 1 and 2 pass, wave 3 is refused and the burst stops: 6 of 40 sent.
      expect(n).toBe(6);
      expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(140);
    } finally {
      srv.close();
    }
  });
});
