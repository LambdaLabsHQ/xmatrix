#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cleanup_script="${script_dir}/cleanup-stale-actions-processes.sh"

if [[ ! -r /proc/self/environ ]]; then
  echo "Stale Actions cleanup test skipped: procfs is unavailable."
  exit 0
fi

fixture_root="$(mktemp -d)"
same_runner_pid=""
other_runner_pid=""

cleanup() {
  [[ -z "${same_runner_pid}" ]] || kill "${same_runner_pid}" 2>/dev/null || true
  [[ -z "${other_runner_pid}" ]] || kill "${other_runner_pid}" 2>/dev/null || true
  rm -rf "${fixture_root}"
}
trap cleanup EXIT

env RUNNER_TRACKING_ID=github_stale_same \
  RUNNER_TEMP="${fixture_root}/runner-a/_work/_temp" sleep 60 &
same_runner_pid="$!"
env RUNNER_TRACKING_ID=github_stale_other \
  RUNNER_TEMP="${fixture_root}/runner-b/_work/_temp" sleep 60 &
other_runner_pid="$!"

RUNNER_TRACKING_ID=github_current \
  RUNNER_TEMP="${fixture_root}/runner-a/_work/_temp" \
  bash "${cleanup_script}"

if kill -0 "${same_runner_pid}" 2>/dev/null; then
  echo "same-runner stale process survived cleanup" >&2
  exit 1
fi
if ! kill -0 "${other_runner_pid}" 2>/dev/null; then
  echo "other-runner process was terminated" >&2
  exit 1
fi

echo "Stale Actions cleanup stays scoped to one runner installation."
