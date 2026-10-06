#!/bin/bash

set -euo pipefail

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <binary> <identifier> <team-id> [label]" >&2
  exit 64
fi

binary="$1"
identifier="$2"
team_id="$3"
label="${4:-macOS CLI}"

if [ ! -f "$binary" ]; then
  echo "Missing $label binary at $binary." >&2
  exit 1
fi

# Keep the standalone daemon executable on one stable Developer ID designated
# requirement across releases. macOS legacy Keychain ACLs authorize this code
# identity; an ad-hoc/linker signature changes on every build and causes an
# authorization dialog after every CLI self-update.
requirement="identifier \"$identifier\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$team_id\""

codesign --verify --strict --verbose=2 -R="$requirement" "$binary"
echo "$label satisfies the xMatrix CLI keychain requirement ($identifier / $team_id)."
