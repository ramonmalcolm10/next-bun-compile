# Cloudflare PPR shell Worker

Serves the static shell of PPR pages from Cloudflare's edge while a
compiled next-bun-compile origin renders only the dynamic holes — the
CDN side of Next's [PPR platform protocol](https://nextjs.org/docs/app/guides/ppr-platform-guide).
The origin side ships in every binary and is pinned by the package's
regression suite (`next-resume: 1` POST → holes only).

**Do you need this?** Only if a page mixes a static frame with
per-request content *and* its first paint matters to a geographically
distributed audience. Fully static pages get the same edge TTFB from a
plain cache rule with zero moving parts; the holes render at origin
speed either way. This Worker buys roughly `origin RTT − 10ms` on
first paint for PPR pages — nothing else.

## One-time setup

```sh
wrangler kv namespace create PPR       # put the id in wrangler.toml
# add a route line per app in wrangler.toml, then:
wrangler deploy
```

The Worker is generic and multi-app: KV keys are prefixed with the
hostname, so one deployment serves every zone you route to it. You
never redeploy it per release.

## Every release (automate in CI)

After the new binary is live (order matters — a new shell must never
resume against an old server):

```sh
KV_NAMESPACE_ID=... ./push-kv.sh your-app.com
```

`push-kv.sh` discovers PPR routes from the build output (any
`.next/server/app/**/*.meta` containing a `postponed` state), pushes
`{shell, postponed, buildId}` as one atomic KV value per route, and
reconciles away keys for routes the new build no longer has.

Entries also carry a TTL as a backstop against orphaned keys (default
90 days, `KV_TTL` to change, `KV_TTL=0` to disable). **The TTL must
comfortably exceed your slowest deploy cadence**: an expired key is
safe (the Worker falls through to full origin rendering — correct
page, origin TTFB) but it's a *silent* performance downgrade until the
next push refreshes it. If you deploy rarely, disable the TTL —
reconciliation, not expiry, is what actually removes stale keys.

## Staleness model

| Situation | What happens |
|---|---|
| Normal release | Same keys overwritten (last-write-wins); all PoPs converge in ~60s |
| Route removed / no longer PPR | Reconciliation pass deletes its key; Worker falls through to origin |
| Orphaned key (missed reconcile) | TTL expires it (90d default; disable with `KV_TTL=0` if you deploy rarely) |
| Key expired before next deploy | Worker falls through to origin — correct page, but edge acceleration silently off until next push |
| Propagation window (~60s post-deploy) | Old shell + old postponed may reach the new origin; if the origin rejects the resume, the visitor gets the shell with its Suspense fallbacks — degraded, never mixed builds |

## Cost

Only PPR-route document GETs invoke the Worker (route patterns +
in-Worker filters keep assets, APIs, and RSC requests on the normal
path). KV reads are the per-request unit (free tier 100k/day, paid
10M/mo included); writes only happen at deploy time.
