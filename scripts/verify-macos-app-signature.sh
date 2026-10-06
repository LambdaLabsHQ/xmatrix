#!/bin/bash

set -euo pipefail

if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  echo "Usage: $0 <app-bundle> <bundle-id> <team-id> [label]" >&2
  exit 64
fi

app_bundle="$1"
bundle_id="$2"
team_id="$3"
label="${4:-macOS app}"

if [ ! -d "$app_bundle" ]; then
  echo "Missing $label bundle at $app_bundle." >&2
  exit 1
fi

# Match the Developer ID designated requirement enforced by Squirrel.Mac. A
# simple `codesign --verify` is insufficient: an adhoc app is internally valid
# but cannot update to a Developer ID build, which stranded the 0.11.36 train.
requirement="identifier \"$bundle_id\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$team_id\""

codesign --verify --deep --strict --verbose=2 -R="$requirement" "$app_bundle"
echo "$label satisfies the xMatrix updater requirement ($bundle_id / $team_id)."
