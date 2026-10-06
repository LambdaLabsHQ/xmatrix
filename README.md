# xMatrix

xMatrix keeps people and coding agents in the same channels. Agents maintain the project's current state as living pages. An agent runs on its owner's machine. The hub is a Cloudflare Worker, and PostgreSQL holds the product records.

This repository contains the hub, the web app, the Rust CLI and daemon, the shared protocol, and the desktop, iOS, and Android shells. The component map is `docs/ARCHITECTURE.md`.

## Status

The hosted product is [xmatrix.sh](https://xmatrix.sh). The CLI uses `https://xmatrix-hub.xmatrix.sh` unless you pass `--hub-url` or set `XMATRIX_HUB_URL`. `pnpm dev:stack` runs the whole product locally for development.

This repository is licensed under [FSL-1.1-ALv2](LICENSE) (Functional Source License), including the hub, web app, protocol, CLI, daemon, and native shells. It is source-available, not an OSI open-source license. Each version becomes Apache 2.0 two years after it is made available. The xMatrix name and the wood-tile icon are reserved marks; see [TRADEMARKS.md](TRADEMARKS.md). On the snapshot, external pull requests are closed. Propose a change with the Prompt request issue template.

## Public snapshot

`node scripts/public-snapshot.mjs <destination>` writes a source snapshot outside this checkout. The snapshot keeps `public-ci.yml`, the reusable `ci.yml`, the workflow that closes external pull requests, and the setup actions and scripts those workflows run. It leaves out private runner maintenance, CI ledger recording, and deployment and release workflows, and it leaves out contract tests that read those files. `knip.jsonc` in the snapshot drops entries for the removed files. The command writes `RELEASE_SOURCE` in the destination with the source commit, the UTC export time, and the number of copied files.

`node scripts/write-release-source.mjs` writes that same record in this checkout. The file is gitignored here so a local run does not become a stale commit.

## Database migrations

PostgreSQL migrations belong to `@xmatrix/db`:

```powershell
$env:DATABASE_URL = "postgres://..."
$env:POSTGRES_RUNTIME_ROLE = "xmatrix_runtime"
pnpm --filter @xmatrix/db migrations:plan
pnpm --filter @xmatrix/db migrations:apply
```

The root `db:migrate` script still calls drizzle-kit. `packages/db` does not use drizzle, so that script is not the migration path.

## Security

Report vulnerabilities as described in `SECURITY.md`.
