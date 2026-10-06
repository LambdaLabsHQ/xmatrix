# Deployment profiles

The committed Wrangler configs (`packages/hub/wrangler.toml`,
`packages/hub/wrangler.test-deploy.toml`, `apps/web/wrangler.jsonc`) describe
the product: bindings, Durable Object classes and migrations, product flags,
and default resource names. A profile in `profiles/` describes one deployment.
`scripts/deploy-config.mjs` merges the two:

```sh
node scripts/deploy-config.mjs render <profile>        # writes wrangler.generated.<profile>.* next to each config
node scripts/deploy-config.mjs env <profile>           # origins and rendered config paths as KEY=VALUE
pnpm --dir packages/hub exec wrangler deploy --config wrangler.generated.<profile>.toml
```

Any string in a profile may be `{ "env": "NAME" }`; it is read from the
environment at render time and rendering fails if it is unset.

| Field | Meaning |
| --- | --- |
| `cloudflare.accountId` | Account the Workers deploy to. |
| `billing` | Optional path (from the repository root) to a billing package. Its `src/index.ts` replaces `@xmatrix/billing` in the Hub bundle. Without it nothing is metered: every Space admits any number of members and messages. The official deployments name their own plan policy here. |
| `hub.config` | Committed Hub config to render (default `packages/hub/wrangler.toml`). |
| `hub.workerName`, `web.workerName` | Worker script names. |
| `hub.origin`, `web.origin` | Bare `https://` origins. They become the custom-domain routes and the Hub's `HUB_URL` / `APP_URL`, and the Web build's `NEXT_PUBLIC_*` URLs. |
| `hub.placementRegion` | Optional Smart Placement region, normally the database's region. |
| `hub.workersDev`, `hub.previewUrls`, `web.workersDev`, `web.previewUrls` | Optional `workers.dev` and preview URL switches. |
| `hub.hyperdrive` | Hyperdrive config id for every `[[hyperdrive]]` binding the deployment keeps. A single-database deployment binds only `RELAY_POSTGRES` and omits `RELAY_POSTGRES_SHARD_1`. |
| `hub.d1` | `{ "<binding>": { "databaseId": … } }` for every D1 binding (the hosted test Hub only). |
| `hub.vars` | Deployment-owned Hub vars: `AUTH_COOKIE_DOMAIN`, `AUTH_COOKIE_PREFIX`, `XMATRIX_EMAIL_FROM`, `PLATFORM_ADMIN_EMAILS`, `PLATFORM_ADMIN_SPACE_ID`, `TEST_ENVIRONMENT_ACCESS_SPACE_ID`, and `RELAY_POSTGRES_SHARD_<n>_ID` for each extra database shard binding. A var may live in the committed config or the profile, never both. |
| `hub.omitBindings`, `web.omitBindings` | Optional bindings this deployment does not provision (for example `RELAY_POSTGRES_SHARD_1`, `RELEASE_ASSETS`). |

`production.json` and `test.json` are the official xMatrix deployments and are
used by the release workflows. Their identity — account, Hyperdrive ids,
operator emails and Space ids — is read through env references from the
release environments' secrets (`CLOUDFLARE_ACCOUNT_ID`, `XMATRIX_HYPERDRIVE_ID`,
`XMATRIX_HYPERDRIVE_SHARD_1_ID`, `XMATRIX_PLATFORM_ADMIN_EMAILS`,
`XMATRIX_PLATFORM_ADMIN_SPACE_ID`), so the profiles ship in the public source
and the values do not. `node scripts/deploy-config.mjs origin <profile> hub|web`
prints one public origin without reading those secrets. `ci.json` holds placeholder values for the CI bundle check, and
`example.json` shows the profile shape.
