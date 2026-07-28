/**
 * Cloudflare Worker implementing the CDN side of Next.js's PPR
 * platform protocol (CDN shell + origin compute) against a
 * next-bun-compile origin. The origin side is guaranteed by the
 * package's regression suite: a POST with `next-resume: 1` and the
 * postponedState blob as the body renders only the deferred holes.
 *
 * One deployment serves any number of apps: KV keys are namespaced by
 * hostname, so each app's CI pushes its own entries and the Worker
 * never changes. See README.md for the KV entry format and the
 * deploy-time push/reconcile script.
 *
 * Request flow:
 *   1. Only GET document requests are candidates; everything else
 *      (assets, APIs, RSC payload requests, POSTs) passes through —
 *      your cache rules and origin behave exactly as without the
 *      Worker.
 *   2. KV lookup `page:<host>:<path>`. Miss → pass through (route
 *      isn't PPR, or artifacts not pushed yet).
 *   3. Hit → stream the cached shell to the visitor immediately
 *      (edge latency), while a resume POST to the origin renders the
 *      dynamic holes in parallel. The hole stream is appended to the
 *      same response.
 *   4. Any resume failure (origin down, postponed/build skew during a
 *      deploy's KV propagation window) degrades to the shell with its
 *      Suspense fallbacks — never a broken or mixed-build page.
 */

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "GET") return fetch(req);

    const url = new URL(req.url);
    // Documents only: RSC/flight requests carry per-request negotiation
    // semantics the origin owns (client-router navigations, prefetches).
    if (
      req.headers.has("rsc") ||
      req.headers.has("next-router-prefetch") ||
      url.searchParams.has("_rsc") ||
      !(req.headers.get("accept") || "").includes("text/html")
    ) {
      return fetch(req);
    }
    // Draft/preview mode is per-request — let the origin handle it.
    if ((req.headers.get("cookie") || "").includes("__prerender_bypass")) {
      return fetch(req);
    }

    const entry = await env.PPR.get(
      `page:${url.hostname}:${url.pathname}`,
      "json"
    );
    if (!entry || !entry.shell || !entry.postponed) return fetch(req);

    // Same-zone subrequests bypass this Worker and hit the origin
    // directly — no recursion, no separate origin URL needed. (For a
    // split setup, set an ORIGIN var and swap url.origin here.)
    const resumeHeaders = new Headers(req.headers);
    resumeHeaders.set("next-resume", "1");
    // Informational: lets origin logs correlate skew during the ~60s
    // KV propagation window after a deploy.
    if (entry.buildId) resumeHeaders.set("x-ppr-shell-build", entry.buildId);

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
          if (res.ok && res.body) {
            // Holes stream in as the origin renders them.
            await res.body.pipeTo(writable);
          } else {
            // Degraded: visitor keeps the shell's Suspense fallbacks.
            // A stale postponed state racing a fresh origin lands here.
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
        ...(entry.buildId && { "x-ppr-shell-build": entry.buildId }),
      },
    });
  },
};
