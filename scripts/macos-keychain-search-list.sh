#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: $0 <add|remove> <absolute-keychain-path>" >&2
  exit 64
}

if [ "$#" -ne 2 ]; then
  usage
fi

action="$1"
target_keychain="$2"
case "$action" in
  add|remove) ;;
  *) usage ;;
esac

case "$target_keychain" in
  /*) ;;
  *)
    echo "Keychain path must be absolute: $target_keychain" >&2
    exit 64
    ;;
esac
case "$target_keychain" in
  *\"*)
    echo "Keychain path must not contain a double quote: $target_keychain" >&2
    exit 64
    ;;
esac

security_bin="${XMATRIX_SECURITY_BIN:-/usr/bin/security}"
lockf_bin="${XMATRIX_LOCKF_BIN:-/usr/bin/lockf}"

if [ ! -x "$security_bin" ]; then
  echo "macOS security tool is not executable: $security_bin" >&2
  exit 69
fi

# The Keychain search list is user-global. Serialize its read/modify/write
# transaction so concurrent self-hosted release jobs cannot overwrite one
# another's ephemeral signing keychains.
if [ "${XMATRIX_KEYCHAIN_SEARCH_LIST_LOCKED:-}" != "1" ]; then
  if [ ! -x "$lockf_bin" ]; then
    echo "macOS lockf tool is not executable: $lockf_bin" >&2
    exit 69
  fi
  export XMATRIX_KEYCHAIN_SEARCH_LIST_LOCKED=1
  exec "$lockf_bin" -k -t 60 \
    "/tmp/xmatrix-keychain-search-list-${UID}.lock" \
    "$0" "$@"
fi

keychains=()
load_keychains() {
  local listed_keychain
  local parsed_keychain
  keychains=()
  while IFS= read -r listed_keychain; do
    # `security list-keychains` indents and quotes every path. Accept only
    # that complete shape: retaining a partially stripped line can turn the
    # indentation and quote into a new, invalid Keychain path.
    if [[ "$listed_keychain" =~ ^[[:space:]]*\"([^\"]+)\"[[:space:]]*$ ]]; then
      parsed_keychain="${BASH_REMATCH[1]}"
    else
      echo "Refusing malformed Keychain search-list entry: $listed_keychain" >&2
      exit 65
    fi
    case "$parsed_keychain" in
      /*) keychains+=("$parsed_keychain") ;;
      *)
        echo "Refusing non-absolute Keychain search-list entry: $parsed_keychain" >&2
        exit 65
        ;;
    esac
  done < <("$security_bin" list-keychains -d user)

  if [ "${#keychains[@]}" -eq 0 ]; then
    echo "Refusing to replace an empty Keychain search list" >&2
    exit 65
  fi
}

updated_keychains=()
append_unique_keychain() {
  local candidate="$1"
  local existing
  if [ "${#updated_keychains[@]}" -gt 0 ]; then
    for existing in "${updated_keychains[@]}"; do
      if [ "$existing" = "$candidate" ]; then
        return
      fi
    done
  fi
  updated_keychains+=("$candidate")
}

load_keychains

if [ "$action" = "add" ]; then
  if [ ! -f "$target_keychain" ]; then
    echo "Signing Keychain does not exist: $target_keychain" >&2
    exit 66
  fi
  append_unique_keychain "$target_keychain"
fi

for keychain in "${keychains[@]}"; do
  if [ "$keychain" != "$target_keychain" ]; then
    append_unique_keychain "$keychain"
  fi
done

if [ "${#updated_keychains[@]}" -eq 0 ]; then
  echo "Refusing to clear the Keychain search list" >&2
  exit 65
fi

"$security_bin" list-keychains -d user -s "${updated_keychains[@]}"

# Verify the global state before releasing the lock. This also catches a
# security(1) invocation that reports success without applying the full list.
expected_keychains=("${updated_keychains[@]}")
load_keychains
if [ "${#keychains[@]}" -ne "${#expected_keychains[@]}" ]; then
  echo "Keychain search-list readback count mismatch" >&2
  exit 74
fi
for ((index = 0; index < ${#expected_keychains[@]}; index += 1)); do
  if [ "${keychains[$index]}" != "${expected_keychains[$index]}" ]; then
    echo "Keychain search-list readback mismatch at index $index" >&2
    exit 74
  fi
done
