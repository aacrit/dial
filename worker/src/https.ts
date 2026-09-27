/**
 * Plain http:// never serves a Dial page (T12). The zone's "Always Use
 * HTTPS" setting would answer it at the edge, but that setting is the
 * founder's dashboard to switch; until then, and whatever the zone does, the
 * Worker answers a plain-http page request with a 301 to the same path on
 * https://. That is the same protection the zone setting gives: a
 * server-side redirect on the first visit, then HSTS (sent on every https
 * answer) keeps the browser on https:// from then on.
 *
 * wrangler.jsonc's run_worker_first lists the page paths so a page request
 * reaches the Worker at all; scripts, styles, fonts and recordings are never
 * loaded over http once the page is on https (every URL in them is relative).
 */

/** Hosts where http:// is how the site is served: local dev and tests. */
function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** Whether the visitor's request reached Cloudflare over plain http. */
export function arrivedOverHttp(request: Request): boolean {
  if (new URL(request.url).protocol === "http:") return true;
  // Cloudflare also states the visitor's scheme in CF-Visitor.
  try {
    return JSON.parse(request.headers.get("cf-visitor") ?? "{}")?.scheme === "http";
  } catch {
    return false;
  }
}

/**
 * The 301 to https:// for a plain-http page request on a deployed host, or
 * null. Only pages (GET or HEAD, not a Worker route): a 301 would turn a
 * POST into a GET, and the API is only ever called from a page already on
 * https://.
 */
export function httpsRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  if (isWorkerRoute(url.pathname) || isLocalHost(url.hostname) || !arrivedOverHttp(request)) return null;
  url.protocol = "https:";
  url.port = "";
  return new Response(null, {
    status: 301,
    headers: { location: url.toString(), "cache-control": "max-age=3600", "x-content-type-options": "nosniff" },
  });
}

/** The Worker's own routes (everything else that reaches it is a page it hands to Workers Static Assets). */
export function isWorkerRoute(pathname: string): boolean {
  return pathname === "/e" || pathname === "/feedback" || pathname === "/healthz" || pathname.startsWith("/api/");
}
