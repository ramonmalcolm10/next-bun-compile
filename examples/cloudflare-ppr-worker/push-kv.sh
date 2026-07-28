#!/usr/bin/env bash
# push-kv.sh <host> — run from the app directory after a successful
# deploy of the new binary (origin must be live BEFORE the shells are
# pushed, so a new shell never resumes against an old server).
#
# Discovers every PPR route in the build output (any .meta file with a
# postponedState), pushes {shell, postponed, buildId} pairs to KV, and
# deletes keys for routes that no longer exist. A 30-day TTL backstops
# anything reconciliation ever misses.
#
# Requires: wrangler (authed or CLOUDFLARE_API_TOKEN with KV write),
# KV_NAMESPACE_ID exported.
set -euo pipefail

HOST="${1:?usage: push-kv.sh <host>}"
: "${KV_NAMESPACE_ID:?export KV_NAMESPACE_ID}"
# Orphan backstop only — reconciliation below is what actually removes
# stale keys. MUST comfortably exceed your slowest deploy cadence: an
# expired key silently downgrades that route to full origin rendering
# until the next push. Set KV_TTL=0 to disable expiry entirely (safe:
# reconciliation still cleans up removed routes).
TTL="${KV_TTL:-7776000}" # default 90 days

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Discover PPR routes and stage one JSON entry per route.
python3 - "$HOST" "$STAGE" <<'EOF'
import json, pathlib, sys
host, stage = sys.argv[1], pathlib.Path(sys.argv[2])
app = pathlib.Path(".next/server/app")
build_id = pathlib.Path(".next/BUILD_ID").read_text().strip()
keys = []
for meta_path in app.rglob("*.meta"):
    meta = json.loads(meta_path.read_text())
    postponed = meta.get("postponed")
    if not postponed:
        continue  # fully static or dynamic route — not PPR
    rel = meta_path.relative_to(app).with_suffix("")
    route = "/" if str(rel) == "index" else "/" + str(rel)
    entry = {
        "shell": meta_path.with_suffix(".html").read_text(),
        "postponed": postponed,
        "buildId": build_id,
    }
    out = stage / f"{len(keys)}.json"
    out.write_text(json.dumps(entry))
    keys.append(f"page:{host}:{route}\t{out}")
(stage / "manifest.tsv").write_text("\n".join(keys) + ("\n" if keys else ""))
print(f"discovered {len(keys)} PPR route(s)")
EOF

# Push current entries (last-write-wins replaces previous build's pair).
TTL_ARGS=()
[ "$TTL" != "0" ] && TTL_ARGS=(--ttl "$TTL")
CURRENT_KEYS=()
while IFS=$'\t' read -r key file; do
  [ -n "$key" ] || continue
  wrangler kv key put "$key" --path "$file" \
    --namespace-id "$KV_NAMESPACE_ID" ${TTL_ARGS[@]+"${TTL_ARGS[@]}"} --remote
  CURRENT_KEYS+=("$key")
done < "$STAGE/manifest.tsv"

# Reconcile: delete keys for this host that the new build no longer has.
wrangler kv key list --namespace-id "$KV_NAMESPACE_ID" --prefix "page:$HOST:" --remote \
  | python3 -c 'import json,sys; [print(k["name"]) for k in json.load(sys.stdin)]' \
  | while read -r existing; do
      keep=false
      for k in ${CURRENT_KEYS[@]+"${CURRENT_KEYS[@]}"}; do
        [ "$k" = "$existing" ] && keep=true && break
      done
      if [ "$keep" = false ]; then
        echo "deleting stale key: $existing"
        wrangler kv key delete "$existing" --namespace-id "$KV_NAMESPACE_ID" --remote
      fi
    done

echo "KV sync complete for $HOST"
