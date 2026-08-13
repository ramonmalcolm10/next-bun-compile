#!/usr/bin/env bash
#
# Retry a command with linear backoff.
#
# Exists for `bun install`. Next's tarball is large, every CI job installs
# it independently, and registry downloads fail transiently often enough
# that a bare install was the single largest source of red runs in this
# repo — always the same shape:
#
#   error: Fail extracting tarball for "next"
#   error: failed to download next@X.Y.Z: Fail
#
# A transient registry failure should cost ten seconds, not a rerun.
set -uo pipefail

attempts=${RETRY_ATTEMPTS:-3}

for ((i = 1; i <= attempts; i++)); do
  "$@" && exit 0
  status=$?
  if ((i == attempts)); then
    echo "::error::'$*' failed after $attempts attempts (exit $status)"
    exit "$status"
  fi
  delay=$((i * 10))
  echo "::warning::'$*' failed (attempt $i/$attempts, exit $status) — retrying in ${delay}s"
  sleep "$delay"
done
