#!/usr/bin/env bash
set -euo pipefail

# Each self-hosted Linux runner executes one job at a time, but a host may run
# several runner installations concurrently. A cancelled worker can leave
# descendants alive after its built-in cleanup has lost track of them, and
# those descendants retain their old RUNNER_TRACKING_ID and RUNNER_TEMP.
# Reclaim only processes from this runner installation; never match another
# runner on the same host, unrelated host processes, or the current job.
current_tracking_id="${RUNNER_TRACKING_ID:-}"
if [[ -z "${current_tracking_id}" ]]; then
  echo "RUNNER_TRACKING_ID is unavailable; stale Actions cleanup skipped"
  exit 0
fi

current_runner_temp="${RUNNER_TEMP:-}"
if [[ -z "${current_runner_temp}" ]]; then
  echo "RUNNER_TEMP is unavailable; stale Actions cleanup skipped"
  exit 0
fi

mode="${1:-previous-jobs}"
if [[ "${mode}" != "previous-jobs" && "${mode}" != "--current-orphans" ]]; then
  echo "usage: $0 [--current-orphans]" >&2
  exit 2
fi

protected_pids=()
if [[ "${mode}" == "--current-orphans" ]]; then
  # The suite may own long-lived infrastructure such as PostgreSQL. Only the
  # completed batch's explicitly tagged processes belong to this cleanup.
  if [[ -z "${XMATRIX_ACTIONS_CLEANUP_BATCH:-}" ]]; then
    echo "Current-batch cleanup requires XMATRIX_ACTIONS_CLEANUP_BATCH" >&2
    exit 2
  fi
  ancestor="$$"
  while [[ "${ancestor}" =~ ^[0-9]+$ && "${ancestor}" -gt 0 ]]; do
    protected_pids+=("${ancestor}")
    parent=""
    {
      while IFS= read -r line; do
        if [[ "${line}" == PPid:* ]]; then
          parent="${line#PPid:}"
          parent="${parent//[[:space:]]/}"
          break
        fi
      done
    } 2>/dev/null < "/proc/${ancestor}/status" || true
    [[ -n "${parent}" && "${parent}" != "${ancestor}" ]] || break
    ancestor="${parent}"
  done
fi

is_protected_pid() {
  local candidate="$1"
  local protected
  for protected in "${protected_pids[@]}"; do
    [[ "${candidate}" == "${protected}" ]] && return 0
  done
  return 1
}

stale_pids=()
# Parsing every process's environment in bash is slow on a busy runner host;
# one grep pass keeps only this runner's processes, and the loop below still
# checks each value exactly.
mapfile -t candidate_files < <(grep -lzF -- "RUNNER_TEMP=${current_runner_temp}" /proc/[0-9]*/environ 2>/dev/null || true)
for environment_file in "${candidate_files[@]}"; do
  pid="${environment_file#/proc/}"
  pid="${pid%/environ}"
  [[ "${pid}" == "$$" ]] && continue

  tracking_id=""
  runner_temp=""
  cleanup_batch=""
  {
    while IFS= read -r -d '' entry; do
      case "${entry}" in
        RUNNER_TRACKING_ID=*) tracking_id="${entry#RUNNER_TRACKING_ID=}" ;;
        RUNNER_TEMP=*) runner_temp="${entry#RUNNER_TEMP=}" ;;
        XMATRIX_ACTIONS_CLEANUP_BATCH=*) cleanup_batch="${entry#XMATRIX_ACTIONS_CLEANUP_BATCH=}" ;;
      esac
    done
  } 2>/dev/null < "${environment_file}" || true

  [[ "${runner_temp}" == "${current_runner_temp}" ]] || continue

  if [[ "${mode}" == "--current-orphans" ]]; then
    [[ "${cleanup_batch}" == "${XMATRIX_ACTIONS_CLEANUP_BATCH}" ]] || continue
    if [[ "${tracking_id}" == "${current_tracking_id}" ]] && ! is_protected_pid "${pid}"; then
      stale_pids+=("${pid}")
    fi
  elif [[ "${tracking_id}" == github_* && "${tracking_id}" != "${current_tracking_id}" ]]; then
    stale_pids+=("${pid}")
  fi
done

if (( ${#stale_pids[@]} == 0 )); then
  echo "No reclaimable Actions descendants found (${mode})"
  exit 0
fi

echo "Terminating ${#stale_pids[@]} reclaimable Actions descendants (${mode})"
kill -TERM "${stale_pids[@]}" 2>/dev/null || true
sleep 1
for pid in "${stale_pids[@]}"; do
  if [[ -d "/proc/${pid}" ]]; then
    kill -KILL "${pid}" 2>/dev/null || true
  fi
done
