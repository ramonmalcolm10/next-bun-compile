# Cloudflare PPR shell Worker (self-populating)

Serves the static shell of PPR pages from Cloudflare's edge while the
origin renders only the dynamic holes. It speaks the
[PPR contract](https://ramonmalcolm10.github.io/next-bun-compile/guides/edge-ppr/#the-ppr-contract)
(`/_ppr/shell`, `/_ppr/resume`, `PPR-Build`), so it works with any
origin that does, a next-bun-compile binary run with `PPR_TOKEN`
included.

**No KV, no push pipeline, no CI changes.** The Worker pulls each
page's shell from the origin on first miss and caches it in
`caches.default`, Cloudflare's native zone cache. A miss passes the
visitor through to the origin unchanged, so no request is ever slower
than having no Worker at all.

**Do you need this?** Only if a page mixes a static frame with
per-request content *and* its first paint matters to a geographically
distributed audience. Fully static pages get the same edge TTFB from a
plain cache rule with zero moving parts; the holes render at origin
speed either way. This Worker buys roughly `origin RTT − 10ms` on
first paint (plus early asset preloading from the shell's `<head>`)
for PPR pages — nothing else.

> Upgrading from the `/_nbc/ppr-shell` version of this Worker? Replace
> `NBC_PPR_SHELL` on the origin with `PPR_TOKEN`, and the Worker's
> `SHELL_TOKEN` secret with a `PPR_TOKEN` secret of the same value.
> The cache keys changed too, so the first request per PoP re-warms.

## Which routes may go in the route list

Serving a shell commits the response head **at the edge**, before the
origin has rendered a byte. Only body bytes can follow it. That gives
one hard rule:

> A route that can emit a `Set-Cookie`, a redirect, or a non-200 status
> before or during its dynamic render must never be routed to this
> Worker.

Auth gates are the obvious case, and the origin already refuses them for
you: a contract origin withholds a shell for any page covered by a
proxy/middleware matcher or a response-altering routing rule, so
`/_ppr/shell` returns `404`, this Worker tombstones it, and the page
passes through. Listing such a route is harmless — it just does
nothing.

**What the build cannot see is on you.** A `redirect()` or `notFound()`
reached from inside a dynamic hole fails exactly the same way on a route
no matcher covers: the origin's resume returns a redirect, its status
and `Location` have nowhere to go, and the visitor is left holding the
shell's Suspense fallbacks. Route only pages whose response head is a
foregone conclusion.

## Building a platform integration?

This Worker needs no input from the build: it discovers shells by asking
the endpoint and remembering 404s. A platform that runs the build can
skip discovery: every build writes `ppr.json` next to the binary, with
the exact list of shell paths and the build id. See
[Edge PPR → The PPR contract](https://ramonmalcolm10.github.io/next-bun-compile/guides/edge-ppr/#the-ppr-contract).

## Setup (once, ever)

1. **Origin**: run the binary with `PPR_TOKEN=<a long random value>`
   (`openssl rand -hex 32`). The contract endpoints exist only then,
   and only for requests carrying it as `PPR-Token`.
2. **Worker**: set your route pattern(s) in `wrangler.toml`, then:

   ```bash
   wrangler secret put PPR_TOKEN   # the same value
   wrangler deploy
   ```

There is no per-release step.

## Request flow

| Situation | What happens |
|---|---|
| Cold PoP (first request in a region / after a purge) | Pass through to origin (zone cache bypassed — see below) while the shell warms in the background |
| Origin has no shell for the page (`404`) | Tombstoned in the cache and passed through until it ages out or a purge — one wasted warm, not one per request |
| Warm PoP | Shell streams from the edge (~10ms first paint, `<head>` asset preloads start immediately); a parallel `POST /_ppr/resume` renders only the per-user holes at the origin and streams them onto the same response |
| Warm PoP, copy older than a minute | Same, plus a background `If-None-Match` check against `/_ppr/shell` — `304` (no body) if the shell is unchanged, otherwise the cached copy is replaced |
| RSC / prefetch / server action / draft mode / non-GET / non-HTML | Pass through, zone cache bypassed |
| Resume answers from another build, or fails | Holes are not appended and the cached shell is evicted; this visitor keeps the shell's Suspense fallbacks — degraded, never mixed builds |
| A visitor requests `/_ppr/…` | `404` from the Worker: those endpoints are the edge's to call |

The cached shell is keyed on a synthetic `/__ppr-shell/<path>` URL, not
on the shell endpoint's own address. `caches.default` is the zone cache,
so a key that names a real URL inherits that URL's cacheability — and
this Worker fetches the endpoint with `cache: "no-store"`. Keying there
would mean asking Cloudflare to cache a URL it has just been told never
to cache: `put()` resolves normally and stores nothing, the shell
re-warms on every request, and nothing is ever served from the edge. No
error is raised, so set `SHELL_DEBUG` and watch for `verify=NOT STORED`
if an integration of your own never seems to warm.

Every pass-through uses `fetch(req, { cache: "no-store" })`, and the
bypass is load-bearing: a Worker subrequest transits Cloudflare's zone
cache, which keys on URL alone and ignores `Vary` — and Next serves a
PPR route's segment-prefetch payloads with `s-maxage=31536000` at the
**same URL** as its document. Without the bypass, one passed-through
prefetch caches flight data under the document's URL, and every
document load on that route returns raw RSC to the browser until the
zone is purged.

## Staleness

- **Deploys**: every resume answers with the origin's `PPR-Build`, and
  the Worker appends the holes only when it matches the cached shell's
  build. After a deploy, the first warm hit per page per PoP gets the
  shell's fallbacks and evicts it; the next request re-warms from the
  new build. A purge-on-deploy job (`purge_everything` on the zone)
  skips even that one degraded load, and clears tombstones too, but
  nothing depends on it.
- **Runtime revalidation**: the origin re-reads a shell when its
  prerender is rewritten — an ISR expiry, or a `use cache` region inside
  the shell whose tag was revalidated — so `/_ppr/shell` serves what the
  origin would.
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
  dynamic holes) does not, since the build check already catches a
  deploy: `1800`–`3600` is the honest setting. Set it in
  `wrangler.toml`:

  ```toml
  [vars]
  SHELL_REVALIDATE_SECONDS = "1800"
  ```
- Nothing user-specific is ever cached: the shell and its state come
  from a prerender — at build time, or a later regeneration — never from
  the context of a visitor's request. The personalized stream is
  `private, no-store`.

## Cost

Only PPR-route document GETs invoke the Worker (route patterns +
in-Worker filters keep assets, APIs, and RSC requests on the normal
path). `caches.default` is Cloudflare's free zone cache — no reads,
writes, or storage billed. Workers free tier: 100k requests/day.
