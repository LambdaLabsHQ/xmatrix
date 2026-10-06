#!/usr/bin/env bash
set -euo pipefail

# A runner owns this checkout, not the other repositories or caches on its host.
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must name the current checkout}"
workspace="$(cd -- "$GITHUB_WORKSPACE" && pwd -P)"
repo_root="$(git -C "$workspace" rev-parse --show-toplevel)"
if [[ "$workspace" != "$repo_root" || "$workspace" == / || "$workspace" == "$HOME" ]]; then
  echo "Refusing cleanup outside the current repository root." >&2
  exit 1
fi

# Validate every parent before removing anything. rm removes a leaf symlink,
# but a symlink in an intermediate directory would traverse another workspace.
for parent in apps apps/desktop; do
  if [[ -L "$workspace/$parent" ]]; then
    echo "Refusing cleanup through symlink: $parent" >&2
    exit 1
  fi
done

rm -rf -- "$workspace/node_modules" "$workspace/.pnpm" "$workspace/apps/desktop/release"
echo "Removed this checkout's dependency links and Desktop build output; shared caches retained."
