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

# Aborted client connections (probes, gateways, users navigating away) must
# tear down silently — they used to log "unhandledRejection: Error: aborted"
# on every disconnect. head closes the pipe early → curl aborts mid-stream.
for _ in 1 2 3 4 5; do
  curl -sN http://127.0.0.1:$PORT/ppr | head -c 16 >/dev/null 2>&1 || true
  curl -sN http://127.0.0.1:$PORT/ssr | head -c 16 >/dev/null 2>&1 || true
done
sleep 1
expect_sh "aborted connections are silent (no unhandledRejection)" "! grep -q 'unhandledRejection\|Error: aborted' '$SERVER_LOG'"
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
shutdown_server

echo
echo "== result: $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]
