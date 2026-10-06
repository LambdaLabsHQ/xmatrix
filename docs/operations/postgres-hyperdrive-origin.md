# PostgreSQL origin behind Hyperdrive

The Hub reaches production PostgreSQL only through two cache-disabled
Hyperdrive configurations (`RELAY_POSTGRES`, `RELAY_POSTGRES_SHARD_1`). Since
2026-10-06 the origin is a managed PlanetScale Postgres 17 cluster in the same
AWS region as the Worker placement hint. It is a deliberate single-node cluster
(no replicas), so this page covers what keeps it healthy without HA.

## Connection budget

The origin allows 50 connections, 3 of them reserved for superusers. Both
shards share it. Hyperdrive limits are soft and can overshoot during
failures, so `scripts/production-hyperdrive-prepare.mjs` pins them at 30
(primary) and 10 (shard 1), leaving room for migrations, operators and the
provider's exporter. Any other Hyperdrive configuration pointing at the same
origin counts against the same 50; delete retired ones rather than leaving
them idle.

## Roles

Hyperdrive logs in as provider-generated roles that carry
`pg_read_all_data`/`pg_write_all_data`. The least-privilege runtime roles
(`xmatrix_prod_runtime`, `xmatrix_prod_shard_1_runtime`) exist and receive the
grants that releases verify, but they were created by the provider's internal
superuser: no role we hold has their ADMIN option, so they cannot be given a
password or role settings. Moving Hyperdrive onto them needs the provider to
create login roles that inherit them. PlanetScale routes logins by a branch
suffix on the user name (`role.branch`); the prepare script accepts that suffix
and checks the role part. Migrations use the separate migration role.

Both databases set `idle_in_transaction_session_timeout` to 60 s
(`ALTER DATABASE ... SET`, new sessions only). Hub transactions set tighter
transaction-local statement, transaction, lock and idle timeouts themselves
(`packages/db/src/client.ts`). There is no server-side statement or
transaction timeout, so any other client (the Better Auth adapter, an
operator) must bound its own queries.

## Session features under Hyperdrive

Hyperdrive pools in transaction mode. Session state does not survive between
transactions: use transaction-local settings (`set_config(..., true)` or
`SET LOCAL`). The Better Auth adapter does not `SET search_path`. Its tables
are `control.auth_*` (`packages/hub/src/auth-postgres-models.ts`), and the
origin role cannot take `ALTER ROLE ... SET`. Transaction-scoped advisory
locks (`pg_advisory_xact_lock`) work, but Hyperdrive documents them as
unsupported; do not add session-level ones. `max_prepared_transactions` is 0, so
`PREPARE TRANSACTION` is unavailable (see
`docs/design/dingtalk-cross-database-effects.md`).

## Watching the pool

`hyperdrivePoolSizesAdaptiveGroups` in the Cloudflare GraphQL API reports
`currentPoolSize`, `maxPoolSize`, `waitingClients` and `availablePoolSlots`
per configuration and pool shard. `waitingClients` above 0 for more than a
minute means the origin connections are held too long; compare with the
`session` points in the substrate observability dataset
([connectivity breaker](postgres-connectivity-breaker.md)).

## Failover and restarts

On a single-node cluster a provider restart or maintenance drops every origin
connection. Hub requests fail with retryable 503s, the connectivity breaker
opens, and single reads retry once on a fresh connection. When the origin is
back but Hyperdrive keeps failing (stale pooled connections), restart the
configuration's pool from the Cloudflare dashboard (Hyperdrive → configuration
→ Danger zone → restart), then confirm `GET /health/postgres` returns 200 and
`waitingClients` returns to 0. Keep transactions short: long ones delay a
provider failover or restart.
