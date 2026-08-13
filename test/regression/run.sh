#!/usr/bin/env bash
# Hermetic regression suite for next-bun-compile.
#
# Packs the package (testing the published artifact, not the working tree),
# scaffolds the fixture app in a temp dir, builds it through the adapter,
# and asserts the behavior contract: tier eligibility, RSC negotiation,
# PPR streaming, ISR stability, server actions, routing-rule exclusion,
# and NBC_RUNTIME_DIR isolation. Every check here corresponds to a real
# bug caught during development.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE_DIR="$PKG_DIR/test/regression/fixture"
WORK="$(mktemp -d /tmp/nbc-regression.XXXXXX)"
PORT="${NBC_TEST_PORT:-3699}"
PASS=0; FAIL=0
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null || true
  if [ "${FAIL:-0}" = "0" ]; then rm -rf "$WORK" 2>/dev/null || true
  else echo "(workdir preserved for debugging: $WORK)"; fi
}
trap cleanup EXIT

expect() { # description, then command to evaluate
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ✓ $d"; PASS=$((PASS+1));
  else echo "  ✗ $d"; FAIL=$((FAIL+1)); fi
}
expect_sh() { # description, shell expression
  local d="$1"; shift
  if bash -c "$*" >/dev/null 2>&1; then echo "  ✓ $d"; PASS=$((PASS+1));
  else echo "  ✗ $d"; FAIL=$((FAIL+1)); fi
}
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@" ; }

BOOTN=0
boot() { # binary-dir [env...]
  BOOTN=$((BOOTN+1)); SERVER_LOG="$WORK/server.$BOOTN.log"
  if lsof -ti :$PORT >/dev/null 2>&1; then
    echo "port $PORT still occupied before boot"; return 1
  fi
  # exec makes the subshell BECOME the server so $! is the real pid.
  ( cd "$1"; shift; exec env "$@" PORT=$PORT ./server >"$SERVER_LOG" 2>&1 ) &
  SERVER_PID=$!; disown 2>/dev/null || true
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return 0
    sleep 0.5
  done
  echo "server failed to boot:"; tail -5 "$SERVER_LOG"; return 1
}
shutdown_server() {
  kill -9 "$SERVER_PID" 2>/dev/null || true; SERVER_PID=""
  for _ in $(seq 1 20); do
    lsof -ti :$PORT >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  lsof -ti :$PORT | xargs kill -9 2>/dev/null || true; sleep 1
}
rmrf_retry() { rm -rf "$@" 2>/dev/null || { sleep 2; rm -rf "$@"; }; }

echo "== pack =="
cd "$PKG_DIR"
TARBALL="$WORK/pkg.tgz"
bun pm pack --destination "$WORK" >/dev/null 2>&1
mv "$WORK"/*.tgz "$TARBALL"

echo "== scaffold =="
APP="$WORK/app"
mkdir -p "$APP"
cp -R "$FIXTURE_DIR/." "$APP/"
cd "$APP"
python3 - "$TARBALL" <<'EOF'
import json, sys
p = json.load(open('package.json'))
p['dependencies']['next-bun-compile'] = 'file:' + sys.argv[1]
json.dump(p, open('package.json','w'), indent=2)
EOF
bun install >/dev/null 2>&1

echo "== build (adapter, single command) =="
# NEXT_DEPLOYMENT_ID exercises the internal skew-header routing rules —
# a catch-all that once disabled the tiers entirely (0 assets + 0 pages).
BUILD_LOG="$WORK/build.log"
NEXT_DEPLOYMENT_ID=testdpl bunx next build >"$BUILD_LOG" 2>&1 || { tail -10 "$BUILD_LOG"; exit 1; }
expect "tier eligibility: 11 assets + 3 pages frozen (deploymentId set)" grep -q "Serving 11 assets + 3 prerendered pages" "$BUILD_LOG"
expect "binary produced by next build alone" test -f server

echo "== behavior =="
boot "$APP"
for r in / /ssr /cached /ppr /api/healthz; do
  expect "GET $r → 200" test "$(code_of http://127.0.0.1:$PORT$r)" = "200"
done
expect "unknown route → 404" test "$(code_of http://127.0.0.1:$PORT/definitely-missing)" = "404"
expect "error document path stays with Next (status intact)" test "$(code_of http://127.0.0.1:$PORT/404)" = "404"
expect "plain POST to static page → 405" test "$(code_of -X POST http://127.0.0.1:$PORT/action)" = "405"

RSC_HDRS=$(curl -s -D- -o /dev/null -H "RSC: 1" http://127.0.0.1:$PORT/ | tr -d '\r')
expect_sh "RSC negotiation on tier page" "echo '$RSC_HDRS' | grep -qi '^content-type: text/x-component'"
expect_sh "deployment skew header on RSC responses" "echo '$RSC_HDRS' | grep -qi '^x-nextjs-deployment-id: testdpl'"

ICON_HDRS=$(curl -s -D- -o /dev/null http://127.0.0.1:$PORT/icon.svg | tr -d '\r')
expect_sh "static metadata route tier-served with seed content-type" "echo '$ICON_HDRS' | grep -qi '^content-type: image/svg+xml' && echo '$ICON_HDRS' | grep -qi '^x-nextjs-cache: HIT'"

BODY=$(curl -s http://127.0.0.1:$PORT/ppr)
expect_sh "PPR streams shell + resumed hole" "grep -q 'static shell' <<<'$BODY' && grep -q 'hole rendered at' <<<'$BODY'"

# PPR resume protocol (Next's ppr-platform-guide, CDN-to-origin): a CDN
# serving a cached shell POSTs the route with `next-resume: 1` and the
# postponedState blob as the body; the origin must render only the
# deferred holes, never a second shell. The blob lives in the page's
# .meta file, extracted next to the binary at boot.
python3 - >"$WORK/postponed.txt" <<'PYEOF'
import json
print(json.load(open('.next/server/app/ppr.meta'))['postponed'], end='')
PYEOF
# The resumed stream legitimately carries the shell's text inside the
# escaped RSC flight payload (hydration data) — only rendered shell
# MARKUP (<main>/<h1>) must be absent.
RESUME=$(curl -s -X POST -H 'next-resume: 1' --data-binary @"$WORK/postponed.txt" http://127.0.0.1:$PORT/ppr)
expect_sh "PPR resume POST renders only the dynamic hole" "test -s '$WORK/postponed.txt' && grep -q 'hole rendered at' <<<'$RESUME' && ! grep -q '<h1>' <<<'$RESUME' && ! grep -q '<main>' <<<'$RESUME'"

S1=$(curl -s http://127.0.0.1:$PORT/cached | grep -o 'stamp: <!-- -->[0-9]*')
S2=$(curl -s http://127.0.0.1:$PORT/cached | grep -o 'stamp: <!-- -->[0-9]*')
expect_sh "ISR page stable across requests (L1)" "test -n '$S1' && test '$S1' = '$S2'"

ETAG=$(curl -s -D- -o /dev/null http://127.0.0.1:$PORT/ | grep -i '^etag' | cut -d' ' -f2 | tr -d '\r')
expect "ETag revalidation → 304" test "$(code_of -H "If-None-Match: $ETAG" http://127.0.0.1:$PORT/)" = "304"

ENC=$(curl -s -D- -o /dev/null -H "Accept-Encoding: gzip" http://127.0.0.1:$PORT/ | grep -ci 'content-encoding: gzip' || true)
expect "gzip negotiation on tier page" test "$ENC" = "1"

ACTION_ID=$(curl -s http://127.0.0.1:$PORT/action | grep -o 'name="\$ACTION_ID_[^"]*"' | head -1 | cut -d'"' -f2)
expect_sh "server action POST executes (no-JS form)" "test -n '$ACTION_ID' && test \$(curl -s -o /dev/null -w '%{http_code}' -X POST -F '$ACTION_ID=' http://127.0.0.1:$PORT/action) = 200"
expect_sh "pages healthy after tag invalidation (tier drop path)" "test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/) = 200 && test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/cached) = 200"

# A *fetch* action (JS-driven, `Next-Action` header) that redirect()s is
# answered by Next self-fetching the target's RSC payload and streaming it
# back, so the client can soft-navigate. It takes the origin from
# __NEXT_PRIVATE_ORIGIN, which `next start` sets on its listening handler —
# and we replace that listener. Left unset, Next fell back to the request's
# initURL, `${x-forwarded-proto}://${HOSTNAME}:${PORT}`, i.e. https://0.0.0.0
# behind any TLS-terminating gateway: handshake failure, empty body, and
# every action redirect in production silently degraded to a full page
# reload. The no-JS form POST above never caught it — that path takes a 303
# Location and never self-fetches. Second form on /action, so ACTION_ID #2.
REDIRECT_FIELD=$(curl -s http://127.0.0.1:$PORT/action | grep -o 'name="\$ACTION_ID_[^"]*"' | sed -n '2p' | cut -d'"' -f2)
REDIRECT_ID="${REDIRECT_FIELD#'$ACTION_ID_'}"
REDIRECT_BODY="$WORK/action-redirect.body"
# `[]` is how the client encodes a zero-argument action call.
REDIRECT_HDRS=$(curl -s -D- -o "$REDIRECT_BODY" -X POST \
  -H "Next-Action: $REDIRECT_ID" -H "x-forwarded-proto: https" \
  -H 'Content-Type: text/plain;charset=UTF-8' --data-binary '[]' \
  http://127.0.0.1:$PORT/action | tr -d '\r')
expect_sh "fetch action redirect signals the client" "echo '$REDIRECT_HDRS' | grep -qi 'x-action-redirect: /'"
expect_sh "fetch action redirect streams the target RSC payload (not an empty body)" "test -s '$REDIRECT_BODY'"
expect_sh "self-fetch origin survives x-forwarded-proto: https" "! grep -q 'failed to get redirect response' '$SERVER_LOG'"

# Aborted client connections (probes, gateways, users navigating away) must
# tear down silently — they used to log "unhandledRejection: Error: aborted"
# on every disconnect. head closes the pipe early → curl aborts mid-stream.
for _ in 1 2 3 4 5; do
  curl -sN http://127.0.0.1:$PORT/ppr | head -c 16 >/dev/null 2>&1 || true
  curl -sN http://127.0.0.1:$PORT/ssr | head -c 16 >/dev/null 2>&1 || true
done
sleep 1
expect_sh "aborted connections are silent (no unhandledRejection)" "! grep -q 'unhandledRejection\|Error: aborted' '$SERVER_LOG'"

# The other half of the same problem: a client that vanishes mid-UPLOAD,
# while the handler is still reading the request body. That tears down a
# different path — the Readable.fromWeb wrapper around the incoming web
# stream — which the response-side check above cannot reach, so its
# staying green says nothing about this one.
#
# No bug here: this was written to test a suspected leak in that path
# (a cancelled reader rejecting with nowhere to go, the way the
# response side once did) and it disproved it. Kept because the gap in
# coverage was real even though the leak wasn't — nothing else in this
# suite aborts a request while the server is still reading it.
cat > "$WORK/abort-upload.js" <<'EOF'
const url = process.argv[2];
for (let i = 0; i < 5; i++) {
  const ac = new AbortController();
  // Never-ending body: guarantees the abort lands while the server reads.
  const body = new ReadableStream({
    async pull(c) {
      c.enqueue(new Uint8Array(64 * 1024));
      await new Promise((r) => setTimeout(r, 25));
    },
  });
  const done = fetch(url, {
    method: "POST", body, signal: ac.signal, duplex: "half",
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  ac.abort();
  await done;
}
EOF
bun "$WORK/abort-upload.js" "http://127.0.0.1:$PORT/api/slow-body" >/dev/null 2>&1 || true
sleep 1
expect_sh "aborted uploads are silent (no unhandledRejection)" "! grep -q 'unhandledRejection' '$SERVER_LOG'"
expect "server alive after aborted connections" test "$(code_of http://127.0.0.1:$PORT/ssr)" = "200"
shutdown_server

echo "== routing-rule exclusion (custom headers) =="
python3 - <<'EOF'
config = open('next.config.ts').read()
config = config.replace('cacheComponents: true,', '''cacheComponents: true,
  async headers() {
    return [{ source: "/action", headers: [{ key: "X-Custom-Policy", value: "test" }] }];
  },''')
open('next.config.ts','w').write(config)
EOF
rmrf_retry .next server
bunx next build >"$WORK/build2.log" 2>&1 || { tail -10 "$WORK/build2.log"; exit 1; }
expect "rule-covered page excluded from tiers" grep -q "Serving 11 assets + 2 prerendered pages" "$WORK/build2.log"
boot "$APP"
HDR=$(curl -s -D- -o /dev/null http://127.0.0.1:$PORT/action | grep -ci 'x-custom-policy: test' || true)
expect "custom header applied via Next" test "$HDR" = "1"
expect "uncovered page still tier-served" test "$(code_of http://127.0.0.1:$PORT/)" = "200"
shutdown_server

echo "== NBC_RUNTIME_DIR isolation =="
DEPLOY="$WORK/deploy"; RUNTIME="$WORK/runtime"
mkdir -p "$DEPLOY"
cp "$APP/server" "$DEPLOY/server"
boot "$DEPLOY" NBC_RUNTIME_DIR="$RUNTIME"
expect_sh "serves with relocated runtime dir" "test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/) = 200 && test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ssr) = 200"
# Hermetic: no project .next to mask a tree missing seeds or route modules.
expect "static metadata seeds+module present in tree" test "$(code_of http://127.0.0.1:$PORT/icon.svg)" = "200"
expect "deploy dir untouched (read-only-fs safe)" test "$(ls -A "$DEPLOY" | wc -l | tr -d ' ')" = "1"
expect "runtime files extracted to NBC_RUNTIME_DIR" test -d "$RUNTIME/.next"
expect "shell endpoint off by default → 404" test "$(code_of http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr)" = "404"
shutdown_server

echo "== PPR shell endpoint (edge-shell protocol) =="
# Same deploy dir + runtime dir: extraction manifest matches, so these
# boots are fast and the endpoint must read from the EXTRACTED tree.
boot "$DEPLOY" NBC_RUNTIME_DIR="$RUNTIME" NBC_PPR_SHELL=1
curl -s "http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr" >"$WORK/shell.json" || true
expect "shell endpoint serves shell + postponed + buildId" python3 -c "
import json
e = json.load(open('$WORK/shell.json'))
assert 'static shell' in e['shell'], 'shell html missing static content'
assert e['postponed'] and isinstance(e['postponed'], str), 'postponed missing'
assert e['buildId'], 'buildId missing'
"
# Full protocol round-trip: the postponed state the ENDPOINT returned must
# resume cleanly — this is exactly what an edge worker will do.
python3 -c "import json; print(json.load(open('$WORK/shell.json'))['postponed'], end='')" >"$WORK/endpoint-postponed.txt" 2>/dev/null || true
RESUMED=$(curl -s -X POST -H 'next-resume: 1' --data-binary @"$WORK/endpoint-postponed.txt" http://127.0.0.1:$PORT/ppr)
expect_sh "endpoint postponed state resumes cleanly" "grep -q 'hole rendered at' <<<'$RESUMED'"
# /cached is ISR without a postponed state — no PPR pair to serve.
# (Note /ssr DOES have one under cacheComponents: its shell is the
# loading fallback, and serving it is correct protocol behavior.)
expect "shell endpoint 404 for non-PPR route" test "$(code_of http://127.0.0.1:$PORT/_nbc/ppr-shell/cached)" = "404"

# An edge shell moves the response HEAD to the CDN, committed before the
# origin renders a byte. Anything the request was going to decide at the
# origin — a proxy redirect, a Set-Cookie, a non-200 — becomes
# unreachable: the CDN has already sent 200 + headers and can only append
# body bytes. So a route whose head isn't the build's to predict must
# never have a shell to hand out.
#
# Middleware coverage is the one form of that we can see statically, and
# Tier 2 already refuses those routes for exactly this reason. The shell
# endpoint handed them out anyway — which in production silently disabled
# the proxy on every warm-shell hit, so auth redirects lost the cookie
# carrying where the user had been headed.
#
# Vacuity guard first: a proxy file Next ignored would make the exclusion
# below pass for the wrong reason.
expect_sh "adapter snapshot records the proxy matcher" "python3 -c \"
import json
s = json.load(open('$APP/.next/nbc-adapter-outputs.json'))
assert s['middlewareMatchers'], 'no matchers recorded — is proxy.ts picked up?'
\""
expect "shell endpoint 404s for a proxy-covered PPR route" test "$(code_of http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr-guarded)" = "404"
# ...while the route itself is untouched: still rendered, still gated.
expect "proxy-covered route still serves from the origin" test "$(code_of http://127.0.0.1:$PORT/ppr-guarded)" = "200"
expect_sh "proxy still decides the head on the covered route" "curl -s -D- -o /dev/null 'http://127.0.0.1:$PORT/ppr-guarded?bounce=1' | tr -d '\r' | grep -qi '^set-cookie: guarded=1'"

# Encoded traversal: %2F survives URL normalization, so this is the form
# that actually reaches the handler's path check.
expect "shell endpoint rejects path traversal" test "$(code_of --path-as-is "http://127.0.0.1:$PORT/_nbc/ppr-shell/..%2F..%2FBUILD_ID")" = "404"

# Conditional revalidation: an edge worker holding a cached shell asks
# "is mine still current?" on a throttle, and an unchanged shell must
# answer with a bodiless 304 — otherwise every check pays a full payload
# and the worker can't afford to run them often enough to matter.
shell_etag() {
  curl -s -D- -o /dev/null "http://127.0.0.1:$PORT/_nbc/ppr-shell/$1" \
    | grep -i '^etag' | cut -d' ' -f2 | tr -d '\r'
}
PPR_ETAG=$(shell_etag ppr)
expect_sh "shell endpoint serves an ETag" "test -n '$PPR_ETAG'"
expect "shell endpoint 304s on a matching If-None-Match" test "$(code_of -H "If-None-Match: $PPR_ETAG" http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr)" = "304"
expect "shell endpoint 200s on a stale If-None-Match" test "$(code_of -H 'If-None-Match: "stale"' http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr)" = "200"

# Revalidation must NOT dark the shell endpoint. A static-shell PPR route
# (revalidate:false) never regenerates at runtime — no set() fires — so a
# dropped entry stayed dropped until reboot, leaving an edge worker on
# origin RTT for the life of the process. The postponed pair is code-shaped
# (same build → still valid), so the endpoint keeps serving it, and the
# served pair still resumes cleanly.
curl -s -X POST http://127.0.0.1:$PORT/api/revalidate-ppr >/dev/null
sleep 1
expect "shell endpoint stays warm across revalidation" test "$(code_of http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr)" = "200"
curl -s "http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr" >"$WORK/shell-reval.json" || true
python3 -c "import json; print(json.load(open('$WORK/shell-reval.json'))['postponed'], end='')" >"$WORK/reval-postponed.txt" 2>/dev/null || true
REVAL=$(curl -s -X POST -H 'next-resume: 1' --data-binary @"$WORK/reval-postponed.txt" http://127.0.0.1:$PORT/ppr)
expect_sh "post-revalidation shell still resumes cleanly" "grep -q 'hole rendered at' <<<'$REVAL'"

# `use cache` data read in a SHELL (not a hole) must not stay build-frozen
# at the edge. Revalidating its tag regenerates the prerender on disk;
# Next serves the new value out of the box, so an endpoint feeding a CDN
# has to match it or the edge serves indefinitely stale content.
shell_stamp() {
  curl -s "http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr-cached" | python3 -c "
import json, re, sys
try:
    shell = json.load(sys.stdin)['shell']
except Exception:
    print(''); raise SystemExit
m = re.search(r'shell stamp: <!-- -->(\d+)', shell)
print(m.group(1) if m else '')
"
}
expect "shell endpoint serves the cached-shell PPR route" test "$(code_of http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr-cached)" = "200"
# The route's tag set travels with the shell so a tag-aware CDN (Fastly
# surrogate keys, Cloudflare Enterprise cache tags) can purge it on
# revalidation instead of waiting out its TTL.
curl -s "http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr-cached" >"$WORK/shell-cached.json" || true
expect "shell endpoint exposes the route's cache tags" python3 -c "
import json
entry = json.load(open('$WORK/shell-cached.json'))
assert 'ppr-shell-demo' in entry['tags'], entry.get('tags')
"
expect_sh "shell endpoint sets Cache-Tag for tag-aware CDNs" "curl -s -D- -o /dev/null http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr-cached | grep -qi '^cache-tag:.*ppr-shell-demo'"
STAMP_BEFORE=$(shell_stamp)
ETAG_BEFORE=$(shell_etag ppr-cached)
curl -s -X POST http://127.0.0.1:$PORT/api/revalidate-shell >/dev/null
STAMP_AFTER="$STAMP_BEFORE"
for _ in $(seq 1 10); do
  curl -s http://127.0.0.1:$PORT/ppr-cached >/dev/null  # request → regenerate
  sleep 1
  STAMP_AFTER=$(shell_stamp)
  [ -n "$STAMP_AFTER" ] && [ "$STAMP_AFTER" != "$STAMP_BEFORE" ] && break
done
ETAG_AFTER=$(shell_etag ppr-cached)
expect_sh "shell endpoint picks up regenerated cached shell data" "test -n '$STAMP_BEFORE' && test '$STAMP_AFTER' != '$STAMP_BEFORE'"
# The ETag must move with the content, or a worker's conditional check
# would 304 forever against a shell that has already changed.
expect_sh "shell ETag changes when the shell regenerates" "test -n '$ETAG_BEFORE' && test '$ETAG_AFTER' != '$ETAG_BEFORE'"
shutdown_server

boot "$DEPLOY" NBC_RUNTIME_DIR="$RUNTIME" NBC_PPR_SHELL=sekret-token
expect "shell endpoint token mode: 401 without header" test "$(code_of http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr)" = "401"
expect "shell endpoint token mode: 200 with header" test "$(code_of -H 'x-nbc-shell-token: sekret-token' http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr)" = "200"
# Token-mode responses must never be storable by a shared cache: a
# zone-wide CDN cache rule would otherwise cache the tokened 200 and
# serve it to anyone, defeating the token entirely (found in prod).
expect_sh "shell endpoint token mode: private, no-store" "curl -s -D- -o /dev/null -H 'x-nbc-shell-token: sekret-token' http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr | grep -qi '^cache-control: private, no-store'"
shutdown_server

echo "== extract mode (bake the tree at image build) =="
# `server --extract` materializes the runtime tree and exits without
# serving. Run it in a Dockerfile RUN step so pod boot hits the manifest
# fast path — the CPU-throttled extraction phase disappears from startup.
EXTRACT_RT="$WORK/extract-runtime"
( cd "$DEPLOY"; exec env NBC_RUNTIME_DIR="$EXTRACT_RT" PORT=$PORT ./server --extract >"$WORK/extract.log" 2>&1 ) &
EX_PID=$!
EX_CODE=124
for _ in $(seq 1 60); do
  if ! kill -0 "$EX_PID" 2>/dev/null; then wait "$EX_PID"; EX_CODE=$?; break; fi
  sleep 0.5
done
kill -9 "$EX_PID" 2>/dev/null || true
expect "--extract exits 0 instead of serving" test "$EX_CODE" = "0"
expect_sh "--extract never starts the server" "! grep -q 'Next.js' '$WORK/extract.log'"
expect "--extract writes the extraction manifest" test -f "$EXTRACT_RT/.next/.nbc-extracted"
boot "$DEPLOY" NBC_RUNTIME_DIR="$EXTRACT_RT"
expect_sh "boot after --extract skips extraction (manifest fast path)" "! grep -q 'Extracted' '$SERVER_LOG'"
expect "serves normally from the pre-extracted tree" test "$(code_of http://127.0.0.1:$PORT/ppr)" = "200"
shutdown_server

echo "== invalidation observation (tier drop end-to-end) =="
# The runtime observes invalidations by patching the IncrementalCache
# wrapper — the layer that delegates to whichever cache handler is
# configured. revalidatePath("/") must drop the frozen route for "/"
# (the drop log line is the proof the hook fired) and the page must
# keep serving through Next afterwards. Only revalidate:false pages are
# frozen, so this is the one invalidation path the tiers depend on.
cd "$APP"
boot "$APP"
expect_sh "frozen page served from memory before invalidation" "grep -q '2 prerendered pages served from memory' '$SERVER_LOG'"
curl -s -X POST http://127.0.0.1:$PORT/api/revalidate-path >/dev/null
sleep 1
expect_sh "revalidatePath drops the frozen page (hook fired)" "grep -q '/ revalidated — serving via Next from now on' '$SERVER_LOG'"
expect "dropped page keeps serving through Next" test "$(code_of http://127.0.0.1:$PORT/)" = "200"
shutdown_server

echo "== custom cacheHandler (singular): failsafe engages =="
# With a custom cacheHandler the frozen tiers are disabled at build:
# in-process observation can't see invalidations issued on OTHER pods
# when the handler is a shared store (Redis), so frozen copies could
# serve stale cross-pod. Pages stay with Next, which reads through the
# handler and honors shared invalidation.
cat > cache-handler.mjs <<'EOF'
// Minimal in-memory singular cacheHandler — the same contract a Redis
// handler implements. The constructor log proves Next instantiated it.
//
// The store is module-level on purpose: Next builds a handler per
// IncrementalCache, so per-instance state would start empty every time
// and every lookup would miss — nothing like the shared backing store
// this stands in for.
const store = new Map();

export default class TestCacheHandler {
  constructor() {
    console.log("nbc-test: custom cache handler loaded");
  }
  async get(key) {
    return store.get(key) ?? null;
  }
  async set(key, data) {
    store.set(key, { value: data, lastModified: Date.now() });
  }
  async revalidateTag() {}
  resetRequestCache() {}
}
EOF
python3 - <<'EOF'
config = open('next.config.ts').read()
config = config.replace('cacheComponents: true,',
  'cacheComponents: true,\n  cacheHandler: process.cwd() + "/cache-handler.mjs",')
open('next.config.ts','w').write(config)
EOF
rmrf_retry .next server
bunx next build >"$WORK/build3.log" 2>&1 || { tail -10 "$WORK/build3.log"; exit 1; }
expect "build announces the tier-off failsafe" grep -q "custom cacheHandler detected" "$WORK/build3.log"
boot "$APP"
expect_sh "no frozen pages at runtime (failsafe active)" "grep -q '0 prerendered pages served from memory' '$SERVER_LOG'"
C1=$(curl -s http://127.0.0.1:$PORT/cached | grep -o 'stamp: <!-- -->[0-9]*')
curl -s -X POST http://127.0.0.1:$PORT/api/revalidate >/dev/null
sleep 1
expect_sh "custom handler instantiated by Next" "grep -q 'nbc-test: custom cache handler loaded' '$SERVER_LOG'"
expect_sh "pages serve and revalidate through the custom handler" "test -n '$C1' && test \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/cached) = 200"
shutdown_server

# The shell endpoint keeps serving under a custom cacheHandler. Its pairs
# come from the build output every pod carries, so they are identical
# everywhere — unlike the frozen page tiers, there is nothing here a
# shared store could make inconsistent between pods. A shell that carries
# `use cache` data does stay build-frozen (regeneration goes to the
# handler, not to disk), which is staleness, not divergence.
boot "$APP" NBC_PPR_SHELL=1
expect "shell endpoint still serves under a custom cacheHandler" test "$(code_of http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr)" = "200"
expect_sh "shell endpoint pair resumes under a custom cacheHandler" "curl -s 'http://127.0.0.1:$PORT/_nbc/ppr-shell/ppr' | python3 -c \"
import json,sys
print(json.load(sys.stdin)['postponed'], end='')
\" > '$WORK/handler-postponed.txt' && curl -s -X POST -H 'next-resume: 1' --data-binary @'$WORK/handler-postponed.txt' http://127.0.0.1:$PORT/ppr | grep -q 'hole rendered at'"

# A regeneration under a custom handler is stored in the handler and
# never touches this pod's disk, so the endpoint can only reflect it by
# reading through the cache — the same source Next reads, and the only
# one that is also correct for a pod that merely reads a shared store
# another pod wrote. Without the read-through this shell stays
# build-frozen until the next deploy.
HSTAMP_BEFORE=$(shell_stamp)
curl -s -X POST http://127.0.0.1:$PORT/api/revalidate-shell >/dev/null
HSTAMP_AFTER="$HSTAMP_BEFORE"
for _ in $(seq 1 10); do
  curl -s http://127.0.0.1:$PORT/ppr-cached >/dev/null  # request → regenerate
  sleep 1
  HSTAMP_AFTER=$(shell_stamp)
  [ -n "$HSTAMP_AFTER" ] && [ "$HSTAMP_AFTER" != "$HSTAMP_BEFORE" ] && break
done
expect_sh "shell endpoint reflects regeneration under a custom cacheHandler" "test -n '$HSTAMP_BEFORE' && test '$HSTAMP_AFTER' != '$HSTAMP_BEFORE'"
shutdown_server

echo
echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]
