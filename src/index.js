/// <reference types="@fastly/js-compute" />
import { CacheOverride } from "fastly:cache-override";

/**
 * Auth sederhana:
 * - header: x-app-key
 * - query : ?key=
 * Saran: pindahkan APP_KEY ke Secret Store Fastly untuk produksi.
 */
const APP_KEY = "key-227014-xyz";
const PROXY_ID = "p2";

/* ====== Tuning Cache (disarankan untuk ramai) ======
   Avatar rig/info: relatif stabil → TTL lebih panjang
   Outfits list   : berubah tapi tidak setiap detik → TTL sedang
*/
const TTL_AVATAR = 900;    // 15 menit
const SWR_AVATAR = 1800;   // 30 menit (serve stale while revalidate)
const SIE_AVATAR = 7200;   // 2 jam (serve stale on error)

const TTL_OUTFITS = 600;   // 10 menit
const SWR_OUTFITS = 900;   // 15 menit
const SIE_OUTFITS = 3600;  // 1 jam

// Catalog bundles: heavy & jarang berubah → TTL panjang (7 hari)
const TTL_BUNDLES = 604800; // 7 hari
const SIE_BUNDLES = 604800; // 7 hari

/* ====== Utils ====== */
function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    // supaya header debug bisa dibaca dari client
    "access-control-expose-headers": "X-Upstream-Status, X-Edge-Cache, X-Proxy-Id"
  };
}
function jres(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "X-Proxy-Id": PROXY_ID,
      ...cors(),
      ...extra,
    },
  });
}

// In-flight dedup per isolate
const inflight = new Map();
async function coalesce(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try { return await fn(); } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

// Retry ringan (tanpa sleep)
async function fetchUpRetry(u, opts, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    const r = await fetch(u, opts);
    if (r.ok) return r;
    if ((r.status === 429 || (r.status >= 500 && r.status < 600)) && i < retries) continue;
    return r;
  }
}

// Canonicalize: sort query params agar key cache stabil
function setSortedParams(dstUrl, srcParams, exclude = new Set()) {
  const pairs = [];
  for (const [k, v] of srcParams.entries()) {
    if (!exclude.has(k)) pairs.push([k, v]);
  }
  pairs.sort(([a],[b]) => a.localeCompare(b));
  for (const [k, v] of pairs) dstUrl.searchParams.set(k, v);
}

/* ====== Handler ====== */
addEventListener("fetch", (event) => event.respondWith(handle(event)));

async function handle(event) {
  const req = event.request;
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors(), "access-control-max-age": "86400", "X-Proxy-Id": PROXY_ID } });
  }

  // Auth sederhana (header atau query)
  const hdrKey = req.headers.get("x-app-key");
  const qKey = url.searchParams.get("key");
  if (APP_KEY && hdrKey !== APP_KEY && qKey !== APP_KEY) {
    return new Response("Forbidden", { status: 403, headers: { ...cors(), "X-Proxy-Id": PROXY_ID } });
  }
  if (qKey) url.searchParams.delete("key"); // bersihkan dari URL publik

  // Health
  if (url.pathname === "/ping") {
    return jres({ ok: true, edge: "fastly", id: PROXY_ID, time: new Date().toISOString() });
  }

  /* ====== CATALOG: GET /catalog/v1/assets/:assetId/bundles ====== */
  if (req.method === "GET" && /^\/catalog\/v1\/assets\/\d+\/bundles$/.test(url.pathname)) {
    const upstream = new URL("https://catalog.roblox.com" + url.pathname.replace(/^\/catalog/, ""));
    // canonical query
    upstream.searchParams.set("limit", "100");
    upstream.searchParams.set("sortOrder", "Asc");

    const co = new CacheOverride("override", {
      ttl: TTL_BUNDLES,
      staleIfError: SIE_BUNDLES,
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
    h.set("X-Proxy-Id", PROXY_ID);
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

    // bypass cache bila ?nocache=1
    const bypass = url.searchParams.get("nocache") === "1";
    // copy query → canonical (sorted), kecuali nocache
    setSortedParams(upstream, url.searchParams, new Set(["nocache"]));

    // TTL berbeda untuk /avatar vs /outfits
    const isAvatarInfo = /\/users\/\d+\/avatar$/.test(upstreamPath);
    const ttl = isAvatarInfo ? TTL_AVATAR : TTL_OUTFITS;
    const swr = isAvatarInfo ? SWR_AVATAR : SWR_OUTFITS;
    const sie = isAvatarInfo ? SIE_AVATAR : SIE_OUTFITS;

    const co = new CacheOverride(bypass ? "pass" : "override", {
      ttl,
      staleWhileRevalidate: swr,
      staleIfError: sie,
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
    h.set("X-Proxy-Id", PROXY_ID);
    const body = await up.arrayBuffer();
    return new Response(body, { status: up.status, headers: h });
  }

  // default
  return jres({
    error: "Blocked path.",
    id: PROXY_ID,
    use: [
      "GET /catalog/v1/assets/{assetId}/bundles",
      "GET /avatar/v1/users/{userId}/avatar",
      "GET /avatar/v1/users/{userId}/outfits"
    ]
  }, 400);
}

