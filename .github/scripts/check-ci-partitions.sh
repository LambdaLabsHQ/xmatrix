#!/usr/bin/env bash
set -euo pipefail

failed=()

record_failure() {
  failed+=("$1")
}

check_partition() {
  local selector_name="$1"
  local selector_value="$2"
  local partition_name="$3"
  local partition_result="$4"

  case "$selector_value" in
    true)
      if [ "$partition_result" != "success" ]; then
        record_failure "$partition_name-required=$partition_result"
      fi
      ;;
    false)
      case "$partition_result" in
        success|skipped) ;;
        *) record_failure "$partition_name-unselected=$partition_result" ;;
      esac
      ;;
    *)
      record_failure "$selector_name-invalid=${selector_value:-<empty>}"
      ;;
  esac
}

if [ "${CHANGES_RESULT:-}" != "success" ]; then
  record_failure "changes-required=${CHANGES_RESULT:-<empty>}"
fi

check_partition "node-selector" "${NODE_CHANGED:-}" "node-checks" "${NODE_CHECKS_RESULT:-}"
check_partition "web-selector" "${WEB_CHANGED:-}" "web" "${WEB_RESULT:-}"
check_partition "hub-selector" "${HUB_CHANGED:-}" "hub" "${HUB_RESULT:-}"
check_partition "desktop-selector" "${DESKTOP_CHANGED:-}" "desktop" "${DESKTOP_RESULT:-}"
check_partition "android-selector" "${ANDROID_CHANGED:-}" "android" "${ANDROID_RESULT:-}"
check_partition "cli-selector" "${CLI_CHANGED:-}" "rust-cli" "${RUST_CLI_RESULT:-}"
check_partition "cli-selector" "${CLI_CHANGED:-}" "rust-cli-windows" "${RUST_CLI_WINDOWS_RESULT:-}"
check_partition "duplicates-selector" "${DUPLICATES_CHANGED:-}" "duplicates" "${DUPLICATES_RESULT:-}"

if [ "${#failed[@]}" -gt 0 ]; then
  printf 'Failed CI partitions: %s\n' "${failed[*]}" >&2
  exit 1
fi

printf 'CI partitions complete: changes=%s node-checks=%s web=%s hub=%s desktop=%s android=%s rust-cli=%s rust-cli-windows=%s duplicates=%s\n' \
  "$CHANGES_RESULT" \
  "$NODE_CHECKS_RESULT" \
  "$WEB_RESULT" \
  "$HUB_RESULT" \
  "$DESKTOP_RESULT" \
  "$ANDROID_RESULT" \
  "$RUST_CLI_RESULT" \
  "$RUST_CLI_WINDOWS_RESULT" \
  "$DUPLICATES_RESULT"
