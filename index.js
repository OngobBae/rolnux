/// <reference types="@fastly/js-compute" />
import { CacheOverride } from "fastly:cache-override";

/**
 * GANTI kunci di sini (atau pindahkan ke Secret Store kalau mau).
 * Auth: header x-app-key atau query ?key=
 */
const APP_KEY = "key-227014-xyz";

/* ====== Utils ====== */
function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,OPTIONS",
  };
}
function jres(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...cors(),
      ...extra,
    },
  });
}

// in-flight dedup per isolate (mirip Worker kamu)
const inflight = new Map();
async function coalesce(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try { return await fn(); } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

// Retry ringan (tanpa delay; Compute nggak support sleep)
async function fetchUpRetry(u, opts, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    const r = await fetch(u, opts);
    if (r.ok) return r;
    if ((r.status === 429 || (r.status >= 500 && r.status < 600)) && i < retries) continue;
    return r;
  }
}

/* ====== Handler ====== */
addEventListener("fetch", (event) => event.respondWith(handle(event)));

async function handle(event) {
  const req = event.request;
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors(), "access-control-max-age": "86400" } });
  }

  // Auth sederhana (header atau query)
  const hdrKey = req.headers.get("x-app-key");
  const qKey = url.searchParams.get("key");
  if (APP_KEY && hdrKey !== APP_KEY && qKey !== APP_KEY) {
    return new Response("Forbidden", { status: 403, headers: { ...cors() } });
  }
  if (qKey) url.searchParams.delete("key"); // bersihkan dari URL publik

  // Health
  if (url.pathname === "/ping") {
    return jres({ ok: true, edge: "fastly", time: new Date().toISOString() });
  }

  /* ====== CATALOG: GET /catalog/v1/assets/:assetId/bundles ====== */
  if (req.method === "GET" && /^\/catalog\/v1\/assets\/\d+\/bundles$/.test(url.pathname)) {
    const upstream = new URL("https://catalog.roblox.com" + url.pathname.replace(/^\/catalog/, ""));
    // samakan canonical query agar cache stabil
    upstream.searchParams.set("limit", "100");
    upstream.searchParams.set("sortOrder", "Asc");

    // Cache 7 hari + serve-stale-on-error
    const co = new CacheOverride("override", {
      ttl: 604800,
      staleIfError: 604800
    });

    const up = await coalesce("CAT:" + upstream.toString(), async () => {
      return fetchUpRetry(upstream.toString(), {
        backend: "rbx_catalog",
        cacheOverride: co,
        headers: { accept: "application/json" },
      }, 1);
    });

    const h = new Headers({ ...cors(), "content-type": "application/json; charset=utf-8" });
    h.set("X-Upstream-Status", String(up.status));
    h.set("X-Edge-Cache", "OVERRIDE");
    const body = await up.arrayBuffer();
    return new Response(body, { status: up.status, headers: h });
  }

  /* ====== AVATAR:
     GET /avatar/v1/users/:userId/avatar
     GET /avatar/v1/users/:userId/outfits
  ====== */
  if (req.method === "GET" && /^\/avatar\/v1\/users\/\d+\/(avatar|outfits)$/.test(url.pathname)) {
    const upstreamPath = url.pathname.replace(/^\/avatar/, "");
    const upstream = new URL("https://avatar.roblox.com" + upstreamPath);

    // copy semua query kecuali nocache
    const bypass = url.searchParams.get("nocache") === "1";
    for (const [k, v] of url.searchParams.entries()) {
      if (k !== "nocache") upstream.searchParams.set(k, v);
    }

    // Cache 60s + stale-while-revalidate 120s + stale-if-error 600s
    const co = new CacheOverride(bypass ? "pass" : "override", {
      ttl: 60,
      staleWhileRevalidate: 120,
      staleIfError: 600,
    });

    const up = await coalesce("AV:" + upstream.toString() + (bypass ? ":pass" : ""), async () => {
      return fetchUpRetry(upstream.toString(), {
        backend: "rbx_avatar",
        cacheOverride: co,
        headers: { accept: "application/json" },
      }, 1);
    });

    const h = new Headers({ ...cors(), "content-type": "application/json; charset=utf-8" });
    h.set("X-Upstream-Status", String(up.status));
    h.set("X-Edge-Cache", bypass ? "BYPASS" : "OVERRIDE");
    const body = await up.arrayBuffer();
    return new Response(body, { status: up.status, headers: h });
  }

  // default
  return jres({
    error: "Blocked path.",
    use: [
      "GET /catalog/v1/assets/{assetId}/bundles",
      "GET /avatar/v1/users/{userId}/avatar",
      "GET /avatar/v1/users/{userId}/outfits"
    ]
  }, 400);
}
