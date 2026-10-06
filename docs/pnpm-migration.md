# PNPM Migration

Status: migrated from Yarn Classic to PNPM 11.

## Operating Model

- PNPM is the only JavaScript package manager for this repository.
- `pnpm-workspace.yaml` is the workspace and package-manager settings source.
- `pnpm-lock.yaml` is the only committed JavaScript lockfile.
- Do not add `yarn.lock`, `package-lock.json`, or Yarn-only workflow steps.
- Use `pnpm install --frozen-lockfile` in CI and clean local setup.
- Use `pnpm --filter <workspace> <script>` for workspace scripts.
- Use `pnpm --filter <workspace> exec <binary>` when invoking a package-local binary directly.
- Use `pnpm exec <binary>` for root-level tools.

## Dependency Policy

Direct JavaScript dependencies are pinned to the versions that were locked before the package-manager migration. This keeps the migration scoped to package-manager behavior instead of bundling dependency upgrades into the same change.

Yarn `resolutions` were migrated to `overrides` in `pnpm-workspace.yaml`.

Existing `patch-package` patches were migrated to PNPM native `patchedDependencies`. Patch files are package-relative diffs and are applied by PNPM during install.

PNPM 11 blocks dependency build scripts unless approved. Reviewed build-script packages are listed under `allowBuilds` in `pnpm-workspace.yaml`. Add new entries only after reviewing why the package needs install-time code execution.

## Local Setup

```sh
pnpm install --frozen-lockfile
pnpm version:check
pnpm --filter @xmatrix/web typecheck
pnpm --filter @xmatrix/hub typecheck
```

Useful workspace commands:

```sh
pnpm web:dev
pnpm --filter @xmatrix/web build
pnpm --filter @xmatrix/hub test
pnpm --filter @xmatrix/desktop build
```

## Store And Worktrees

PNPM uses a machine-level content-addressed store and links packages into each worktree. This is the dependency reuse layer for disposable xMatrix run worktrees.

On the Windows migration machine, the store path was:

```text
C:\Users\dev\AppData\Local\pnpm\store\v11
```

If a worktree install is corrupted, remove that worktree's `node_modules` and rerun:

```sh
pnpm install --frozen-lockfile
```

Do not delete the global PNPM store as a routine fix; that defeats warm worktree reuse.

## Benchmark Notes

Environment: Windows worktree at `C:\Users\dev\.xmatrix\worktrees\run-0b818c995ebe`, PNPM 11.3.0, Node 25.8.0, warm PNPM store after package resolution.

Observed during migration:

- `pnpm install --lockfile-only`: about 53 seconds with PNPM supply-chain policy verification enabled.
- First successful `pnpm install --frozen-lockfile` after package linking/build approval fixes: about 39 seconds.
- Warm no-op `pnpm install --frozen-lockfile --reporter silent`: about 0.72 seconds.
- Linked package entries under `node_modules/.pnpm`: 1186.

Three Windows temp worktrees copied from the migrated tree and installed against the same PNPM store produced:

| Run | Install seconds | Logical `node_modules` MiB |
| --- | ---: | ---: |
| 1 | 239.02 | 1474.5 |
| 2 | 61.86 | 1474.5 |
| 3 | 184.24 | 1474.5 |

The Windows PNPM store was `C:\Users\dev\AppData\Local\pnpm\store\v11`; measured store size changed from 1918.2 MiB to 1918.3 MiB across those three installs.

Two Yarn 1.22.22 baseline temp checkouts created from `HEAD` before the migration produced:

| Run | Install seconds | Logical `node_modules` MiB |
| --- | ---: | ---: |
| 1 | 86.29 | 1453.4 |
| 2 | 84.82 | 1453.4 |

Yarn's cache was `C:\Users\dev\AppData\Local\Yarn\Cache\v6`. On this Windows host the PNPM store reuse strongly reduced store growth, but install wall time was noisy and not consistently faster than Yarn 1.

Because xMatrix run worktrees also target Linux-like daemon environments, the same migrated tree was copied into WSL2 ext4 and installed into three fresh temp worktrees with a warm PNPM store:

| Run | Install seconds | Logical `node_modules` MiB |
| --- | ---: | ---: |
| 1 | 8.12 | 1468 |
| 2 | 7.70 | 1468 |
| 3 | 8.06 | 1468 |

The WSL PNPM store was `/mnt/c/Users/dev/.pnpm-store/v11`; measured store size stayed at 1280 MiB before and after the three installs. This is the target worktree shape: fresh worktrees mostly link from the machine store with no package-store growth.

## Verification Notes

The migration was verified with:

```sh
pnpm install --frozen-lockfile
pnpm peers check
pnpm version:check
pnpm check:reachability
pnpm check:duplicates
pnpm --filter @xmatrix/protocol build
pnpm --filter @xmatrix/web typecheck
pnpm --filter @xmatrix/web test
pnpm --filter @xmatrix/web build
pnpm --filter @xmatrix/hub typecheck
pnpm --filter @xmatrix/hub test
pnpm --filter @xmatrix/desktop test
pnpm --filter @xmatrix/desktop build
pnpm --filter @xmatrix/desktop dist:win
pnpm android:bundle-web
```

`pnpm --filter @xmatrix/web build:cloudflare` was verified in a clean WSL2 ext4 copy of the migrated tree. The first Windows attempt failed on OpenNext's documented Windows compatibility boundary while reading `.open-next/.../node_modules/.pnpm/...`; the ext4 run passed after the web and hub direct scripts were updated to build `@xmatrix/protocol` first.

`pnpm --filter @xmatrix/desktop dist:win` verified the Windows Electron release asset path with PNPM-managed native dependency rebuilds. `pnpm android:bundle-web` verified the Android web asset bundle path.

## Troubleshooting

- `ERR_PNPM_FETCH_404` for an internal `@xmatrix/*` package means the dependency should use `workspace:*`.
- `ERR_PNPM_IGNORED_BUILDS` means a dependency with install scripts is missing from `allowBuilds`.
- TypeScript errors that reference `.pnpm/.../node_modules/...` usually mean a package had an implicit dependency or an exported inferred type is leaking a transitive dependency path.
- `pnpm peers check` should pass before merging package-manager changes.
