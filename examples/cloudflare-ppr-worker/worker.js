/**
 * Cloudflare Worker serving PPR shells from the edge against any origin
 * that speaks the PPR contract (v1), such as a next-bun-compile binary
 * run with PPR_TOKEN — self-populating edition.
 *
 * No KV, no build-time push pipeline, no marker: on a cache miss the
 * request passes through to the origin unchanged (never slower than no
 * worker), while the shell is fetched once in the background from the
 * origin's contract endpoint:
 *
 *   GET  /_ppr/shell?path=<decoded path>     →  { v, build, html, state }
 *   POST /_ppr/resume?url=<path and query>   →  the holes only
 *
 * and stored in `caches.default` — Cloudflare's native zone cache,
 * nothing to provision or administer. Warm requests stream the cached
 * shell at edge latency while the resume renders only the dynamic holes
 * at the origin.
 *
 * Staleness is handled without help from the deploy:
 *   - every resume answers with the origin's PPR-Build, and holes are
 *     appended only when it is the cached shell's build — a shell from
 *     another deploy is evicted and that one visitor keeps the shell's
 *     Suspense fallbacks, never mixed builds;
 *   - a warm hit older than SHELL_REVALIDATE_SECONDS re-checks the shell
 *     with If-None-Match, so a regenerated shell reaches the edge too.
 *   A purge-on-deploy job still helps (it clears tombstones as well), but
 *   correctness no longer depends on it.
 *
 * Required secret:
 *   PPR_TOKEN — the same value the origin runs with. Sent as PPR-Token;
 *               without it the origin's endpoints don't exist (404).
 *
 * ── Which routes may be listed in wrangler.toml ──────────────────────
 *
 * Serving a shell commits the response head HERE, at the edge, before
 * the origin has rendered anything. Only body bytes can follow. So:
 *
 *   A route that can emit a Set-Cookie, a redirect, or a non-200 status
 *   before or during its dynamic render must never be routed here.
 *
 * The origin enforces the statically-provable half of that on its own:
 * a contract origin withholds a shell for any page a proxy matcher or a
 * response-altering routing rule covers, so /_ppr/shell 404s, this
 * Worker tombstones it, and the route passes through for good. Auth
 * gates are covered by that.
 *
 * The rest is on whoever writes the route list. A `redirect()` or
 * `notFound()` reached from inside a dynamic hole is invisible to the
 * build and fails the same way — the redirect is swallowed and the
 * visitor is left holding the shell's Suspense fallbacks. Route only
 * pages whose response head is a foregone conclusion.
 */

// How long a PoP may hold a shell, and how long before a warm hit checks
// the origin for a newer one. The check is conditional, so an unchanged
// shell costs a bodiless 304 — cheap enough to run far more often than
// the TTL, which is what keeps a regenerated shell from sitting stale at
// the edge for the rest of its hour.
//
// Override the gap per app with SHELL_REVALIDATE_SECONDS in
// wrangler.toml [vars]. A shell that only changes on deploy (a static
// frame around dynamic holes) can check far less often: the resume's
// build check already catches a deploy.
const SHELL_TTL = 3600;
const REVALIDATE_AFTER_SECONDS = 60;

// The origin marks every /_ppr/ answer private/no-store so no cache on
// the way can hold a tokened response — only this worker-private copy
// may, so every cached shell is re-wrapped on the way in. ETag carries
// over to drive conditional revalidation.
const shellHeaders = (src) => {
  const headers = {
    "content-type": "application/json",
    "cache-control": `public, max-age=${SHELL_TTL}`,
    "x-ppr-cached-at": String(Date.now()),
  };
  const etag = src.headers.get("etag");
  if (etag) headers.etag = etag;
  return headers;
};

const fetchShell = (origin, path, env, etag) =>
  fetch(`${origin}/_ppr/shell?path=${encodeURIComponent(path)}`, {
    // A freshness check must never be answered by a copy on the way:
    // without this the zone could hand back the very shell we are trying
    // to replace.
    cache: "no-store",
    headers: {
      accept: "application/json",
      "ppr-token": env.PPR_TOKEN,
      ...(etag ? { "if-none-match": etag } : {}),
    },
  });

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
    // Set SHELL_DEBUG in wrangler.toml [vars] to trace which branch a
    // request takes. Off by default: on a warm route this would log once
    // per request.
    const debug = (msg) => {
      if (env.SHELL_DEBUG) console.log(msg);
    };

    const url = new URL(req.url);
    // The origin's contract endpoints are the edge's to call, never a
    // visitor's.
    if (url.pathname.startsWith("/_ppr/")) {
      return new Response(null, { status: 404 });
    }
    if (!env.PPR_TOKEN) {
      console.log("PPR_TOKEN is not set — passing everything through");
      return passThrough();
    }
    if (req.method !== "GET") return passThrough();

    // Documents only: RSC/flight requests carry per-request negotiation
    // semantics the origin owns (client-router navigations, prefetches,
    // actions), and a range or a subresource fetch isn't a page load.
    const dest = req.headers.get("sec-fetch-dest");
    if (
      req.headers.has("rsc") ||
      req.headers.has("next-router-prefetch") ||
      req.headers.has("next-router-segment-prefetch") ||
      req.headers.has("next-router-state-tree") ||
      req.headers.has("next-action") ||
      req.headers.has("range") ||
      (dest && dest !== "document") ||
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

    // The contract names pages by their decoded path.
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return passThrough();
    }
    // A cache key is an identifier, not a fetch target, and must never be
    // a URL this Worker also fetches. caches.default IS the zone cache,
    // so keying on the endpoint's own URL inherits whatever cacheability
    // that URL picked up — and the shell fetch asks for it with
    // `cache: "no-store"`. Telling Cloudflare never to cache a URL and
    // then asking it to cache that URL loses: put() resolves fine and
    // stores nothing, so the shell re-warms on every request and is
    // never served, with no error raised anywhere. A synthetic key is
    // judged only on the response it is handed.
    const cacheKey = new Request(`${url.origin}/__ppr-shell${url.pathname}`);
    const cached = await caches.default.match(cacheKey);

    if (!cached) {
      debug(`shell miss ${path} — warming`);
      // Cold PoP: this visitor takes the origin path; the shell warms in
      // the background for the next one. Same-zone subrequests bypass
      // this Worker — no recursion, no separate origin URL needed.
      ctx.waitUntil(
        (async () => {
          const res = await fetchShell(url.origin, path, env);
          if (res.status === 404) {
            // Not a failure — a standing answer. The origin has no shell
            // for this path: no PPR pair, or a page whose response head
            // it refuses to hand to a CDN (see above). It will keep
            // saying 404 until the next deploy, so record that, or this
            // warm re-runs on every document load. The contract answers a
            // wrong PPR-Token with a 404 too, so if every route
            // tombstones, check the token matches the origin's. The
            // tombstone ages out with SHELL_TTL, or a purge clears it.
            await caches.default.put(
              cacheKey,
              new Response(JSON.stringify({ noShell: true }), {
                headers: shellHeaders(res),
              })
            );
            debug(`shell absent ${path} — tombstoned`);
            return;
          }
          if (!res.ok) {
            // A warm that never succeeds is otherwise invisible: the
            // visitor still gets a correct page from the origin, so the
            // only symptom is an edge that never warms. Keep retrying,
            // and keep saying so.
            console.log(`shell warm failed ${path}: status=${res.status}`);
            return;
          }
          const body = await res.arrayBuffer();
          try {
            await caches.default.put(
              cacheKey,
              new Response(body, { headers: shellHeaders(res) })
            );
            if (env.SHELL_DEBUG) {
              // A put Cloudflare declines resolves without throwing, so
              // reading the key straight back is the only way to tell
              // "written" from "accepted and discarded". Costs a second
              // lookup per warm, so it stays behind the flag.
              const check = await caches.default.match(cacheKey);
              console.log(
                `shell warmed ${path} (${body.byteLength}b) verify=${check ? "STORED" : "NOT STORED"}`
              );
            }
          } catch (err) {
            console.log(`shell cache put failed ${path}: ${err && err.message}`);
          }
        })()
      );
      return passThrough();
    }

    // A shell regenerates when its page revalidates — an ISR expiry, or
    // a `use cache` region inside the shell whose tag was revalidated.
    // The origin serves the new one immediately; this copy would other-
    // wise sit stale until its TTL ran out, so check in the background
    // once the copy is old enough. The visitor is never blocked.
    const configured = Number(env.SHELL_REVALIDATE_SECONDS);
    const revalidateAfter =
      (Number.isFinite(configured) && configured > 0
        ? configured
        : REVALIDATE_AFTER_SECONDS) * 1000;
    const cachedAt = Number(cached.headers.get("x-ppr-cached-at") || 0);
    const recheck = Date.now() - cachedAt > revalidateAfter;

    let entry;
    try {
      entry = await cached.json();
    } catch {
      entry = null;
    }
    if (entry && entry.noShell) {
      // Tombstone from a prior warm: this page is the origin's alone.
      debug(`shell absent ${path} (cached) — passing through`);
      return passThrough();
    }
    if (
      !entry ||
      entry.v !== 1 ||
      typeof entry.html !== "string" ||
      typeof entry.state !== "string" ||
      !entry.build
    ) {
      // A cached entry that can't be used is worth hearing about
      // unconditionally: it means this page passes through on every hit
      // while the cache reports a hit, so nothing else would show it.
      console.log(`shell entry unusable ${path} — evicting`);
      ctx.waitUntil(caches.default.delete(cacheKey));
      return passThrough();
    }
    debug(`shell hit ${path} — serving from edge`);

    if (recheck) {
      ctx.waitUntil(
        (async () => {
          const res = await fetchShell(
            url.origin,
            path,
            env,
            cached.headers.get("etag")
          );
          if (res.status === 304) {
            // Unchanged — restamp so the next hit doesn't check again
            // immediately. Re-serializing the entry we just parsed keeps
            // the body we already hold.
            await caches.default.put(
              cacheKey,
              new Response(JSON.stringify(entry), {
                headers: shellHeaders(cached),
              })
            );
            return;
          }
          if (res.status === 404) {
            // No longer a shell here (a deploy changed the page).
            await caches.default.delete(cacheKey);
            return;
          }
          if (!res.ok) return;
          const body = await res.arrayBuffer();
          await caches.default.put(
            cacheKey,
            new Response(body, { headers: shellHeaders(res) })
          );
        })()
      );
    }

    // The dynamic holes are per-user — the origin needs the original
    // headers (cookies included) to render THIS visitor's content. They
    // flow only worker → origin, the same path they already travel;
    // nothing user-specific is ever cached. Accept-Encoding goes: this
    // Worker's response is compressed whole by Cloudflare, so the resume
    // must come back as plain bytes to append.
    const resumeHeaders = new Headers(req.headers);
    for (const name of [...resumeHeaders.keys()]) {
      if (name.startsWith("ppr-")) resumeHeaders.delete(name);
    }
    resumeHeaders.delete("accept-encoding");
    resumeHeaders.set("ppr-token", env.PPR_TOKEN);
    resumeHeaders.set("ppr-build", entry.build);
    resumeHeaders.set("content-type", "application/octet-stream");
    const resume = fetch(
      `${url.origin}/_ppr/resume?url=${encodeURIComponent(path + url.search)}`,
      {
        method: "POST",
        cache: "no-store",
        headers: resumeHeaders,
        body: entry.state,
      }
    );

    const { readable, writable } = new TransformStream();
    ctx.waitUntil(
      (async () => {
        const writer = writable.getWriter();
        try {
          // The shell goes out at once, before anything from the origin.
          await writer.write(new TextEncoder().encode(entry.html));
          writer.releaseLock();
          const res = await resume;
          const build = res.headers.get("ppr-build");
          const type = res.headers.get("content-type") || "";
          if (res.status === 200 && build === entry.build && type.startsWith("text/html") && res.body) {
            await res.body.pipeTo(writable);
            return;
          }
          // Another build answered (a deploy since this shell was cached)
          // or the resume failed: evict so the next request re-warms
          // against the current build. This visitor keeps the shell's
          // Suspense fallbacks — degraded, never mixed builds.
          console.log(
            `resume not appended ${path}: status=${res.status} build=${build} cached=${entry.build}`
          );
          if (res.body) res.body.cancel().catch(() => {});
          await caches.default.delete(cacheKey);
          await writable.close();
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
        "x-ppr-shell-build": entry.build,
      },
    });
  },
};
