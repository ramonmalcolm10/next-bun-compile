# Cloudflare PPR shell Worker (self-populating)

Serves the static shell of PPR pages from Cloudflare's edge while a
compiled next-bun-compile origin renders only the dynamic holes — the
CDN side of Next's [PPR platform protocol](https://nextjs.org/docs/app/guides/ppr-platform-guide).
The origin side ships in every binary and is pinned by the package's
regression suite (`next-resume: 1` POST → holes only).

**No KV, no push pipeline, no CI changes.** The Worker pulls each
route's shell from the origin's opt-in endpoint on first miss and
caches it in `caches.default` — Cloudflare's native zone cache. A miss
passes the visitor through to the origin unchanged, so no request is
ever slower than having no Worker at all.

**Do you need this?** Only if a page mixes a static frame with
per-request content *and* its first paint matters to a geographically
distributed audience. Fully static pages get the same edge TTFB from a
plain cache rule with zero moving parts; the holes render at origin
speed either way. This Worker buys roughly `origin RTT − 10ms` on
first paint (plus early asset preloading from the shell's `<head>`)
for PPR pages — nothing else.

## Setup (once, ever)

1. **Origin**: set `NBC_PPR_SHELL=1` (or `NBC_PPR_SHELL=<token>` to
   require an `x-nbc-shell-token` header — recommended for auth-gated
   routes so their skeletons aren't publicly enumerable). The binary
   then serves `GET /_nbc/ppr-shell/<route>` →
   `{ shell, postponed, buildId }`, precomputed at boot and served
   from memory like every other tier.
2. **Worker**: set your route pattern(s) in `wrangler.toml`, add
   `SHELL_TOKEN` (as a secret) if the origin uses token mode, then
   `wrangler deploy`.

There is no per-release step. Deploys are handled by the
infrastructure you already run (see below).

## Request flow

| Situation | What happens |
|---|---|
| Cold PoP (first request in a region / after a purge) | Pass through to origin (zone cache bypassed — see below) while the shell warms in the background |
| Warm PoP | Shell streams from the edge (~10ms first paint, `<head>` asset preloads start immediately); a parallel `next-resume` POST renders only the per-user holes at the origin and streams them onto the same response |
| Warm PoP, copy older than a minute | Same, plus a background `If-None-Match` check against the endpoint — `304` (no body) if the shell is unchanged, otherwise the cached copy is replaced |
| RSC / prefetch / draft-mode / non-GET / non-HTML | Pass through, zone cache bypassed |
| Resume fails (origin down, build skew) | Cached shell is evicted; this visitor keeps the shell's Suspense fallbacks — degraded, never mixed builds |

Every pass-through uses `fetch(req, { cache: "no-store" })`, and the
bypass is load-bearing: a Worker subrequest transits Cloudflare's zone
cache, which keys on URL alone and ignores `Vary` — and Next serves a
PPR route's segment-prefetch payloads with `s-maxage=31536000` at the
**same URL** as its document. Without the bypass, one passed-through
prefetch caches flight data under the document's URL, and every
document load on that route returns raw RSC to the browser until the
zone is purged.

## Staleness

- **Deploys**: a purge-on-deploy job (`purge_everything` on the zone)
  clears cached shells with everything else; the next request per PoP
  re-warms from the new build. The endpoint's `max-age` is the backstop
  if you don't purge.
- **Runtime revalidation**: a route revalidating on the origin does
  *not* drop its endpoint entry. The binary re-reads the pair when the
  prerender is rewritten — an ISR expiry, or a `use cache` region inside
  the shell whose tag was revalidated — so the endpoint serves what the
  origin would. A shell that never regenerates keeps its build-frozen
  pair for the life of the process; only a new build changes the
  postponed state, and that is a new process which re-reads at boot.
- **The cached copy revalidates itself**: the origin cannot evict a
  Cloudflare cache entry, so the Worker re-checks instead. On a warm hit
  whose cached copy is older than `SHELL_REVALIDATE_SECONDS` (60 by
  default) it asks the endpoint with `If-None-Match` in the background —
  an unchanged shell answers `304` with no body, a regenerated one
  replaces the copy. A regenerated shell therefore reaches visitors about
  a minute later rather than up to an hour, for one bodiless subrequest
  per PoP per minute.

  **Tune it to your shells.** A shell that carries `use cache` data earns
  the default. A shell that only changes on deploy (a static frame around
  dynamic holes) does not: behind a purge-on-deploy job every check
  returns `304`, so `1800`–`3600` is the honest setting. Drop the purge
  and it inverts — the check becomes what carries the edge across a
  deploy, and until it runs a stale shell resumes against a new build,
  fails, and degrades that visitor to the shell's fallbacks. Set it in
  `wrangler.toml`:

  ```toml
  [vars]
  SHELL_REVALIDATE_SECONDS = "1800"
  ```
- **Tag-aware zones can skip the wait**: the endpoint sends `Cache-Tag`
  (Next's tag set for the route) and the Worker carries it onto the
  cached copy, so a Cloudflare Enterprise zone can purge a shell by tag
  on revalidation instead of waiting for the next check.
- Nothing user-specific is ever cached: the shell, postponed state, and
  buildId all come from a prerender — at build time, or a later
  regeneration — never from the context of a visitor's request. The
  personalized stream is `private, no-store`.

## Cost

Only PPR-route document GETs invoke the Worker (route patterns +
in-Worker filters keep assets, APIs, and RSC requests on the normal
path). `caches.default` is Cloudflare's free zone cache — no reads,
writes, or storage billed. Workers free tier: 100k requests/day.
