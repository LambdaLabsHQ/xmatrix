# PostgreSQL Substrate: M1 Execution Contract

Status: M1 accepted on 2026-08-29. M1 changes no product authority.

## North star

`@xmatrix/db` is the only code and migration boundary through which the Hub
accesses PostgreSQL. Every database operation is explicitly request-scoped and,
for Space facts, placement-scoped. It is bounded, timed, observable without
exposing query data, and executed against the correct cache policy. Every schema change is immutable,
checksummed, ledgered, and deployed with an expand/contract decision. A schema,
shadow, cache, or migration receipt never becomes product authority merely by
existing.

A Space retains one stable identity and one active placement with a monotonically
increasing epoch. The placement contract routes that Space over a finite shard
fleet; it does not create one physical database or Hyperdrive pool per Space.

## Hard boundaries

- M1 does not move auth, Space, Channel, message, or any other product authority.
- Correctness reads, writes, migrations, and health checks use the cache-disabled
  Hyperdrive binding. The cached binding is reserved for explicitly stale-safe
  projections behind a separate API.
- Runtime Workers never apply migrations during startup or a request. Only the
  exact-revision deployment workflow may mutate the schema.
- SQL migrations are append-only. An applied checksum or phase mismatch fails
  closed; historical migrations are never edited in place.
- Expand migrations may add compatible structures and ship with releases.
  Contract migrations require the explicit `--allow-contract` flag and run only
  through the PostgreSQL Contract Migration operator workflow.
- Query telemetry records stable operation names, timing, outcome, row count,
  and shard identity. It never records SQL text, parameters, credentials, or
  returned data.
- Every query has a declared result bound. Transactions have connection,
  statement, lock, idle, and total transaction timeouts.
- Placement rows contain routing identity and state, never database credentials.

## Package reset

The prior private Drizzle/Supabase prototype had no runtime consumer and modeled
obsolete `public` tables and identities. M1 removes it rather than retaining a
legacy subtree. Git history is the historical record. The rebuilt package uses
the currently supported `pg` driver and begins a new `control` / `data`
migration sequence at `0000`.

M1 deliberately does not pre-create speculative auth or product-domain tables.
Those tables land with their owning M2 or M3 domain after the current D1/DO
contract has been mapped. M1 creates only migration, placement, idempotency,
outbox, and logical-storage substrate.

## Delivery stages

### M1-A — Package and migration contract

Status: accepted on 2026-08-28.

- Rebuild `@xmatrix/db` around a cache-disabled authority client.
- Require request, operation, and optional complete placement context.
- Add transaction-local PostgreSQL context and bounded query telemetry.
- Add immutable `control` / `data` SQL migrations and a checksummed ledger.
- Add expand/contract policy, plan/apply commands, and contract tests.

Acceptance: package build, typecheck, unit tests, migration manifest check, and
repository checks pass. No Hub import or remote database mutation occurs.

### M1-B — Hub and Hyperdrive integration

Status: accepted on 2026-08-28. Evidence is recorded in
Next M1-B acceptance (record retired with the Next environment).

- Make Hub depend on `@xmatrix/db` and construct the authority client only from
  `RELAY_POSTGRES`.
- Add PostgreSQL liveness/readiness and slow-query observations.
- Prove connection, timeout, rollback, cleanup, cached-binding isolation, and
  transient-failure behavior in Next.

Acceptance: an exact-SHA Next deployment can read PostgreSQL health through the
fresh binding while all product authority remains D1/DO.

### M1-C — Operational substrate

Status: accepted on 2026-08-29. Evidence is recorded in
Next M1-C acceptance (record retired with the Next environment).

The host-local PITR, base-backup, offsite-sync, and restore-drill implementation
used for that acceptance was retired by maintainer direction on 2026-09-07.
The acceptance record is historical evidence, not a description of a currently
installed recovery service or a requirement for the present integration stage.

- Apply the exact checked-in migrations to Next PostgreSQL through a gated
  deployment operation and read back the ledger and schema identities.
- Seed shard 0 placement metadata without creating product facts.
- Record logical storage accounting probes and capacity alert thresholds.
- Preserve the historical isolated restore evidence from the accepted M1-C
  exercise without retaining its host-local PITR implementation.

Acceptance: a clean database can be migrated and an independent restored copy
can pass ledger, schema, and data-digest verification.

## M1 completion

M1-A through M1-C are accepted. PostgreSQL is operationally trustworthy but
still owns no product facts. M2 starts the first shadow and authority-cutover
protocol and requires explicit maintainer direction.
