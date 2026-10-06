#!/usr/bin/env bash
# Prints how many rustc processes this job may run at once: its share of the
# processors, within 3 GiB of available memory per rustc (debug info is off;
# two rustc ran within a 2-CPU, 8 GiB GitHub-hosted VM). A self-hosted machine
# is shared by several runners, so a job takes a quarter of its processors; a
# GitHub-hosted runner is a machine of its own (RUNNER_ENVIRONMENT), so a job
# takes all of them. Never less than one.
#
# Usage: rust-compile-jobs.sh [meminfo-file] [processor-count]
set -euo pipefail

meminfo="${1:-/proc/meminfo}"
processors="${2:-$(getconf _NPROCESSORS_ONLN)}"
if [ -r "$meminfo" ]; then
  memory_kib="$(awk '/^MemAvailable:/ { print $2 }' "$meminfo")"
else
  memory_kib="$(( $(sysctl -n hw.memsize) / 1024 ))"
fi
[[ "$memory_kib" =~ ^[0-9]+$ && "$processors" =~ ^[0-9]+$ ]] || {
  echo "cannot read available memory or processor count" >&2
  exit 1
}

memory_jobs="$(( memory_kib / (3 * 1024 * 1024) ))"
if [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ]; then
  processor_jobs="$processors"
else
  processor_jobs="$(( processors / 4 ))"
fi
jobs="$(( memory_jobs < processor_jobs ? memory_jobs : processor_jobs ))"
if [ "$jobs" -lt 1 ]; then jobs=1; fi
echo "Rust compile parallelism: $jobs (available memory $(( memory_kib / 1024 / 1024 )) GiB, $processors processors)" >&2
echo "$jobs"
