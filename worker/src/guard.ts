// Request guards that run before any handler touches D1: a per-client rate
// limit, and the checks that keep another site's page from making a
// visitor's browser post here.
//
// Privacy (V3): the rate limit is keyed on the client's network, derived
// from CF-Connecting-IP only at call time (clientKey below). The key goes
// to the Workers Rate Limiting binding, which counts in memory at the
// Cloudflare location serving the request and stores nothing; this file
// never writes an address to D1, a log or a response.
//
// A refused request is still a Worker invocation: these limits make abuse
// cheap to refuse, but they do not bound the account's daily invocations.
// The zone's WAF rule (the /release skill's preconditions) caps bursts
// before the Worker runs; the rest is an accepted risk signed at G3.

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface GuardEnv {
  /** Every Worker request that has no binding of its own: /healthz, /api/*, unmatched paths. 20 per 10 s (wrangler.jsonc). */
  RL_API?: RateLimiter;
  /** POST /e. 6 per 60 s: a visit sends a page view, a tune-in per work and a listen, far below it, while one script can no longer push the success event past the kill line in minutes. */
  RL_EVENTS?: RateLimiter;
  /** POST /feedback. 2 per 60 s: nobody writes three messages a minute, and one client can no longer use up the day's shared feedback ceiling. */
  RL_FEEDBACK?: RateLimiter;
}

export type LimiterName = keyof GuardEnv;

/** Seconds until a limited client should retry: each binding's period (wrangler.jsonc; tests/hardening.test.ts keeps them equal). */
export const LIMITER_PERIOD_SECONDS: Record<LimiterName, number> = { RL_API: 10, RL_EVENTS: 60, RL_FEEDBACK: 60 };

/** Requests each binding allows per period (wrangler.jsonc; tests/hardening.test.ts keeps them equal). */
export const LIMITER_LIMITS: Record<LimiterName, number> = { RL_API: 20, RL_EVENTS: 6, RL_FEEDBACK: 2 };

/**
 * Which limiter a request counts against. Every request that reaches the
 * Worker counts against exactly one: static assets never reach it
 * (wrangler.jsonc's run_worker_first lists only the Worker's routes), so
 * this covers /healthz and unmatched paths too. The two write paths have
 * their own, tighter bindings (the pre-Proof audit, 2026-09-26).
 */
export function limiterFor(method: string, pathname: string): LimiterName {
  if (method === "POST" && pathname === "/e") return "RL_EVENTS";
  if (method === "POST" && pathname === "/feedback") return "RL_FEEDBACK";
  return "RL_API";
}

/** The plain words a refused client gets with its 429, beside `error: "rate_limited"`. */
export function rateLimitedMessage(name: LimiterName): string {
  const wait = LIMITER_PERIOD_SECONDS[name] >= 60 ? "a minute" : `${LIMITER_PERIOD_SECONDS[name]} seconds`;
  return `Too many requests from this network. Wait ${wait}, then try again.`;
}

/** Expands an IPv6 address to 8 hextets, or null if it is not one. Handles "::" and an embedded dotted IPv4 tail. */
function ipv6Hextets(ip: string): number[] | null {
  let addr = ip.trim().toLowerCase();
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  if (!addr.includes(":")) return null;
  // A dotted IPv4 tail (::ffff:192.0.2.1) becomes its two hextets.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    addr = `${addr.slice(0, v4.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/**
 * How much of an IPv6 address keys each limit. One subscriber usually holds
 * a whole /64 and often a /56 (the common home delegation), and could
 * otherwise rotate through it; the write paths, where rotating would buy
 * counts or messages, key by /56 (CoS decision J), the rest by /64.
 */
export const LIMITER_V6_PREFIX: Record<LimiterName, 56 | 64> = { RL_API: 64, RL_EVENTS: 56, RL_FEEDBACK: 56 };

/**
 * The rate-limit key for a client address: an IPv4 address as is (whole);
 * an IPv6 address by its network, /64 (the first four hextets) or /56 (the
 * first three and a half); an IPv4-mapped IPv6 address (::ffff:a.b.c.d) as
 * the IPv4 address it is. Anything unparseable is used as given.
 */
export function clientKey(ip: string | null, v6Prefix: 56 | 64 = 64): string {
  if (!ip) return "no-ip";
  const h = ipv6Hextets(ip);
  if (!h) return ip.trim();
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join(".");
  }
  const net = h.slice(0, 4);
  if (v6Prefix === 56) net[3] = net[3]! & 0xff00;
  return `${net.map((x) => x.toString(16)).join(":")}::/${v6Prefix}`;
}

/**
 * True when the request may go on. A missing binding (unit tests, a local
 * `wrangler dev`) lets the request through, and so does a binding that
 * throws: the daily ceilings still bound D1, so failing open costs at most
 * what they allow, while failing closed would take the product down with
 * the limiter. A throw is not silent: `onError` runs (the Worker counts it
 * as the aggregate `rate_limiter_error`), with no address and no log line.
 */
export async function withinRateLimit(
  env: GuardEnv,
  name: LimiterName,
  request: Request,
  onError: () => Promise<unknown> = async () => undefined,
): Promise<boolean> {
  const limiter = env[name];
  if (!limiter) return true;
  // Derived here and handed straight to the binding; never stored or logged.
  const key = clientKey(request.headers.get("cf-connecting-ip"), LIMITER_V6_PREFIX[name]);
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    try {
      await onError();
    } catch {
      // Counting the failure must never turn into a failed request.
    }
    return true;
  }
}

/**
 * Cross-site POST refusal. A browser marks another site's request with
 * `Sec-Fetch-Site: cross-site` (or `same-site`, from another subdomain of
 * the same zone) and an `Origin` that is not ours.
 *
 * - With `Sec-Fetch-Site` (every current browser sends it, and a page
 *   cannot forge it), only `same-origin` passes. It is trusted over
 *   `Origin` because it is the browser's own verdict, made against the
 *   address the browser actually used: behind `wrangler dev` or a dev
 *   proxy the Worker sees a rewritten URL that no browser Origin matches.
 * - Without it (an older browser), an `Origin` must be this Worker's own
 *   origin.
 * - With neither (curl, a script), it is not a browser acting for a
 *   visitor, so it is allowed; the rate limit still applies.
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site !== "same-origin";
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin !== new URL(request.url).origin;
}

/**
 * Every POST body here is JSON. Requiring the JSON media type turns away
 * the "simple" cross-site posts (text/plain, form encodings) that a browser
 * sends without a CORS preflight.
 */
export function isJsonContentType(request: Request): boolean {
  const type = request.headers.get("content-type");
  if (!type) return false;
  return type.split(";")[0].trim().toLowerCase() === "application/json";
}
