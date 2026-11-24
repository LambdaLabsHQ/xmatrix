#!/usr/bin/env bash
# Stop any running kache daemon for the active cache directory and clear the
# ephemeral store so a second target on the same hosted VM can restore its own
# Actions cache archive cleanly without mixing stores.
set -euo pipefail

cache_dir="${KACHE_CACHE_DIR:-$HOME/.cache/kache}"
if [ -n "${RUSTC_WRAPPER:-}" ]; then
  state_file="$cache_dir/daemon.state.json"
  pid=""
  if [ -f "$state_file" ]; then
    pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$state_file" 2>/dev/null | head -n 1 || true)"
  fi
  "$RUSTC_WRAPPER" daemon stop || true
  if [ -n "$pid" ]; then
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
  fi
fi

rm -rf "$cache_dir"
mkdir -p "$cache_dir"
