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
- **Runtime revalidation**: if a PPR route revalidates on the origin,
  the binary drops that route's endpoint entry (it would pair an old
  postponed state with a new origin). The Worker's cached copy then
  fails its next resume, self-evicts, and re-warms.
- Nothing user-specific is ever cached: the shell, postponed state,
  and buildId are all computed at `next build` time, before any
  request exists. The personalized stream is `private, no-store`.

## Cost

Only PPR-route document GETs invoke the Worker (route patterns +
in-Worker filters keep assets, APIs, and RSC requests on the normal
path). `caches.default` is Cloudflare's free zone cache — no reads,
writes, or storage billed. Workers free tier: 100k requests/day.
