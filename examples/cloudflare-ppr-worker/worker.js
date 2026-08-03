/**
 * Cloudflare Worker implementing the CDN side of Next.js's PPR
 * platform protocol (CDN shell + origin compute) against a
 * next-bun-compile origin — self-populating edition.
 *
 * No KV, no build-time push pipeline: on a cache miss the request
 * passes through to the origin unchanged (never slower than no
 * worker), while the shell is fetched once in the background from the
 * origin's opt-in endpoint (`NBC_PPR_SHELL=...` on the origin):
 *
 *   GET /_nbc/ppr-shell/<route>  →  { shell, postponed, buildId }
 *
 * and stored in `caches.default` — Cloudflare's native zone cache,
 * nothing to provision or administer. Warm requests stream the cached
 * shell at edge latency while a resume POST renders only the dynamic
 * holes at the origin.
 *
 * Staleness is handled by infrastructure you already run:
 *   - a purge-on-deploy job clears the zone cache, shells included
 *     (the endpoint's max-age is the backstop);
 *   - a failed resume (e.g. build skew inside the purge window)
 *     evicts the cached shell and degrades that one request to the
 *     shell's Suspense fallbacks — never mixed builds.
 *
 * Optional env var (wrangler.toml [vars] or a secret):
 *   SHELL_TOKEN — sent as x-nbc-shell-token when the origin runs the
 *                 endpoint in token mode (NBC_PPR_SHELL=<token>).
 */

export default {
  async fetch(req, env, ctx) {
    // Pass-through is NOT the no-worker behavior by default: a Worker
    // subrequest transits the zone cache, which keys on URL alone and
    // ignores Vary — and Next serves segment-prefetch flight payloads
    // with s-maxage=31536000 at the same URL as the document. Let one
    // into the cache and every document load on the route returns raw
    // flight data until the zone is purged. no-store skips the zone
    // cache in both directions.
    const passThrough = () => fetch(req, { cache: "no-store" });
    if (req.method !== "GET") return passThrough();

    const url = new URL(req.url);
    // Documents only: RSC/flight requests carry per-request negotiation
    // semantics the origin owns (client-router navigations, prefetches).
    if (
      req.headers.has("rsc") ||
      req.headers.has("next-router-prefetch") ||
      req.headers.has("next-router-segment-prefetch") ||
      url.searchParams.has("_rsc") ||
      !(req.headers.get("accept") || "").includes("text/html")
    ) {
      return passThrough();
    }
    // Draft mode (next's COOKIE_NAME_PRERENDER_BYPASS) is per-request —
    // let the origin handle it.
    if ((req.headers.get("cookie") || "").includes("__prerender_bypass")) {
      return passThrough();
    }

    const route = url.pathname === "/" ? "/index" : url.pathname;
    const shellUrl = new URL(`/_nbc/ppr-shell${route}`, url.origin);
    const cacheKey = new Request(shellUrl.toString());
    const cached = await caches.default.match(cacheKey);

    if (!cached) {
      // Cold PoP: this visitor takes the origin path; the shell warms in
      // the background for the next one. Same-zone subrequests bypass
      // this Worker — no recursion, no separate origin URL needed.
      ctx.waitUntil(
        (async () => {
          const res = await fetch(shellUrl.toString(), {
            headers: env.SHELL_TOKEN
              ? { "x-nbc-shell-token": env.SHELL_TOKEN }
              : {},
          });
          if (!res.ok) return;
          // Re-wrap before caching: the origin marks token-mode
          // responses private/no-store so the zone CDN can never serve
          // them without the token — only this worker-private copy may
          // hold them.
          const body = await res.arrayBuffer();
          await caches.default.put(
            cacheKey,
            new Response(body, {
              headers: {
                "content-type": "application/json",
                "cache-control": "public, max-age=3600",
              },
            })
          );
        })()
      );
      return passThrough();
    }

    let entry;
    try {
      entry = await cached.json();
    } catch {
      entry = null;
    }
    if (!entry || !entry.shell || !entry.postponed) return passThrough();

    // The dynamic holes are per-user — the origin needs the original
    // headers (cookies included) to render THIS visitor's content. They
    // flow only worker → origin, the same path they already travel;
    // nothing user-specific is ever cached.
    const resumeHeaders = new Headers(req.headers);
    resumeHeaders.set("next-resume", "1");
    // Without this, fetch() stamps string bodies text/plain — which Next
    // 405s before its resume branch (as do octet-stream and friends).
    // Urlencoded takes the no-JS form-post path, where next-resume is
    // honored (verified against production Next 16.2.4).
    resumeHeaders.set("content-type", "application/x-www-form-urlencoded");
    const resume = fetch(url.toString(), {
      method: "POST",
      headers: resumeHeaders,
      body: entry.postponed,
    });

    const { readable, writable } = new TransformStream();
    ctx.waitUntil(
      (async () => {
        const writer = writable.getWriter();
        try {
          await writer.write(new TextEncoder().encode(entry.shell));
          writer.releaseLock();
          const res = await resume;
          if (!res.ok) {
            console.log(`resume failed ${url.pathname}: status=${res.status}`);
          }
          if (res.ok && res.body) {
            await res.body.pipeTo(writable);
          } else {
            // Likely build skew: evict so the next request re-warms
            // against the current build. This visitor keeps the shell's
            // Suspense fallbacks — degraded, never mixed builds.
            await caches.default.delete(cacheKey);
            await writable.close();
          }
        } catch {
          try {
            await writable.abort();
          } catch {}
        }
      })()
    );

    return new Response(readable, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The combined stream contains per-request content — neither
        // the edge cache nor the browser may store it.
        "cache-control": "private, no-store",
        // Worker-served documents never transit the origin/gateway, so
        // its security headers must be mirrored here. Keep in sync with
        // the gateway's ResponseHeaderModifier set.
        "strict-transport-security": "max-age=31536000",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "same-origin",
        ...(entry.buildId && { "x-ppr-shell-build": entry.buildId }),
      },
    });
  },
};
