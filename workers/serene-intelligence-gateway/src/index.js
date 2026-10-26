/**
 * Serene Intelligence — Cloudflare edge gateway.
 * Requires a separately hosted FastAPI origin. Cloudflare Workers cannot execute Python FastAPI directly.
 * All admin and authentication endpoints remain inaccessible through this public gateway.
 */
const ALLOWED_ORIGINS = new Set([
  "https://serenecreations.org",
  "https://www.serenecreations.org",
  "https://serene-ai.serenecreations.org"
]);
const ALLOWED_PATHS = new Set(["/api/health", "/api/chat"]);
const MAX_BODY_BYTES = 16384;

function headersFor(origin) {
  const h = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (ALLOWED_ORIGINS.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
  }
  return h;
}
function json(data, status, headers) {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: h });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = headersFor(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: ALLOWED_ORIGINS.has(origin) ? 204 : 403, headers });
    }
    if (!ALLOWED_PATHS.has(url.pathname)) return json({ error: "Not found" }, 404, headers);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Forbidden origin" }, 403, headers);
    if (url.pathname === "/api/chat" && (!env.RATE_KV || !env.RATE_KV.get || !env.RATE_KV.put)) return json({ error: "Rate limiter unavailable" }, 503, headers);
    if (url.pathname === "/api/chat" && request.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
    if (url.pathname === "/api/health" && request.method !== "GET") return json({ error: "Method not allowed" }, 405, headers);
    if (!env.BACKEND_ORIGIN || !env.GATEWAY_SERVER_TOKEN) return json({ error: "Gateway not configured" }, 503, headers);
    let target;
    try {
      target = new URL(env.BACKEND_ORIGIN);
      if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash || target.pathname !== "/") throw Error("Invalid origin");
    } catch { return json({ error: "Gateway configuration invalid" }, 503, headers); }
    if (url.pathname === "/api/chat") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const key = "serene-chat:" + new Date().toISOString().slice(0, 13) + ":" + ip;
      let current;
      try { current = Number(await env.RATE_KV.get(key) || "0"); }
      catch { return json({ error: "Rate limiter unavailable" }, 503, headers); }
      if (current >= 20) return json({ error: "Hourly chat quota reached" }, 429, headers);
      try { await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 7200 }); }
      catch { return json({ error: "Rate limiter unavailable" }, 503, headers); }
      const length = Number(request.headers.get("Content-Length") || 0);
      if (length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413, headers);
      if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json({ error: "JSON required" }, 415, headers);
    }
    const targetUrl = new URL(url.pathname, target);
    const outgoing = new Headers({ "Accept": "application/json", "X-Gateway-Token": env.GATEWAY_SERVER_TOKEN });
    let body;
    if (request.method === "POST") {
      body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413, headers);
      outgoing.set("Content-Type", "application/json");
    }
    try {
      const response = await fetch(targetUrl, { method: request.method, headers: outgoing, body, redirect: "manual", signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400) return json({ error: "Upstream redirect rejected" }, 502, headers);
      const contentType = response.headers.get("Content-Type") || "";
      if (!contentType.includes("application/json")) return json({ error: "Unexpected upstream response" }, 502, headers);
      const payload = await response.text();
      if (payload.length > 1048576) return json({ error: "Upstream response too large" }, 502, headers);
      const h = new Headers(headers); h.set("Content-Type", "application/json");
      return new Response(payload, { status: response.status, headers: h });
    } catch { return json({ error: "Backend unavailable" }, 502, headers); }
  }
};
