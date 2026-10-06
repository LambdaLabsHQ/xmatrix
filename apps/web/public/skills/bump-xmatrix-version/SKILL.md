---
name: bump-xmatrix-version
description: How xMatrix release versions work now. Use when a user asks to bump, prepare, verify, or explain the xMatrix release version for CLI, daemon, web, desktop, Android, or iOS, or asks why main's version.json lags the newest release tag. Releasing needs no version-bump PR: the release train chooses and stamps the version.
---

# Bump xMatrix Version

## Overview

**Releasing does not need a version bump on `main`.** A Production Release
Intent names only the components. The release train chooses the next patch above
every published release (or `main`'s own version when that is higher), stamps
it onto the frozen `main` SHA as one release commit (`scripts/release-commit.mjs`),
and tests, tags and ships that commit. `main`'s `version.json` may therefore lag the newest
`xmatrix-v*` tag; that is expected. To release, start one intent naming the
components: `gh workflow run production-release-intent.yml --ref main -f release_components=hub,web,cli`.

Use the workflow below only when a branch genuinely needs its own manifests to
carry a version (for example to test a client's update behavior locally). It is
the same `version.mjs set` the release request runs.

## Canonical Policy

Read `docs/release-updates.md` before changing a version. The root `version.json` file is the canonical xMatrix version source of each released revision, and released web, CLI, daemon, desktop, Android, and iOS artifacts for a train carry that same version.

Do not bump only `Cargo.toml`, a package manifest, an app project file, or a GitHub release tag. Use the repository version script so all generated manifests stay synchronized.

## Workflow

1. Confirm the worktree and current version:

   ```bash
   git status --short --branch
   node scripts/version.mjs check
   node -p "require('./version.json').version"
   ```

2. Choose the next semver release train. For a normal patch release, increment the patch version, for example `0.11.28` to `0.11.29`.

3. Bump the version with the canonical script:

   ```bash
   PNPM version:set <version>
   ```

   This updates `version.json` first, then syncs root and workspace package manifests, `packages/cli-rs/Cargo.toml`, every xMatrix package entry in `packages/cli-rs/Cargo.lock`, and iOS native release metadata.

4. Verify consistency:

   ```bash
   PNPM version:check
   git diff -- version.json package.json apps packages/cli-rs/Cargo.toml packages/cli-rs/Cargo.lock
   ```

   Ensure the `Cargo.lock` diff includes every `xmatrix-cli-*` package entry, not only the top-level `xmatrix` package. `PNPM version:check` should catch stale internal Rust crate entries.

5. Commit only the version-bump files unless another requested change explicitly belongs in the same release prep:

   ```bash
   git add version.json package.json apps/web/package.json apps/desktop/package.json packages/hub/package.json packages/protocol/package.json packages/db/package.json packages/mock-agent/package.json packages/cli-rs/Cargo.toml packages/cli-rs/Cargo.lock apps/ios/xMatrix.xcodeproj/project.pbxproj
   git commit -m "chore: bump xMatrix version to <version>"
   ```

6. Open the PR following the repository guardrails. Mention the version, the reason for the bump, and the `PNPM version:check` result. Do not open such a PR just to release: the release request stamps the version itself.

## Release Behavior

The release workflows read the version from the checked-out release commit, which the release train stamped with the version it chose (the next patch above every published release, or a higher version already on `main`). To release a minor or major bump, merge that version to `main` with this workflow; the next train uses it. If installed clients still report an old version after a release, check which `xmatrix-v*` tag the release used and whether that component was in the train's scope (the union of its intents' `release_components`).
