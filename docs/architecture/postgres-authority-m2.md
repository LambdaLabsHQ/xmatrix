# PostgreSQL Authority M2

Status: Auth and user preferences are PostgreSQL-authoritative in Next. Auth
has no D1 runtime binding and carries a terminal `source_retired` receipt.
Space/Channel control facts are fully archived and partly normalized in
PostgreSQL, but their complete command closures remain DO-authoritative.

## North star

- PostgreSQL owns durable business and Auth facts plus the transactional
  outbox.
- Durable Objects serialize commands, allocate order, fence stale placement,
  and keep bounded reconstructable cache/retry state.
- D1 is removed after Auth cutover.
- R2 keeps immutable payload bytes; PostgreSQL keeps their metadata.
- Correctness traffic uses cache-disabled Hyperdrive.
- A Space is the placement and migration unit over a finite shard fleet. It is
  not one physical database or Hyperdrive configuration per Space.

`next` proves this architecture. The same migrations, repositories, shadow
tools, comparison logic, and authority flags must later merge into `main`
without rewriting them for another environment.

## Current authority closures

PostgreSQL authorities separate current access from lifecycle by named
capability. Archived Channels remain readable while new work stays frozen; see
[PostgreSQL Channel capability policy](message-channel-lifecycle-capabilities.md).

| Domain | Current authority | Facts that move together |
| --- | --- | --- |
| Auth and Human Profile | PostgreSQL `control` | user, session, account, verification, JWKS, signup invites/claims, retired handles |
| Space root | Relay Space-root authority | Space directory, management state, billing state |
| Membership and ACL | Relay Space-membership authority | members, invites, join requests, creation policy, channel access |
| Channel catalog | Relay Channel-catalog authority | channel identity, hierarchy, archive and metadata |
| User preferences | PostgreSQL `data` | locale and channel-view preferences |

The Human Profile stored in Relay is a projection of D1 Auth. The current
`create-space` command writes the Space, owner membership, and billing usage in
one transaction, so later PostgreSQL work must preserve that command closure.

## Delivery stages

### M2-A — Auth target

Status: accepted on 2026-08-29.

- Export the complete `xmatrix-auth-postgres-shadow-v1` D1-to-PostgreSQL
  mapping from `@xmatrix/db`.
- Add empty PostgreSQL Auth tables and a chained migration-receipt table.
- Extend schema, backup, and restore verification for those tables.
- Keep every Auth read and write on D1.

### M2-B — Shadow copy

Status: accepted on 2026-08-29. See
Next M2-B acceptance (record retired with the Next environment).

- Add a D1 outbox covering all eight Auth tables. Events contain only sequence,
  table, primary key, operation, and timestamp.
- Backfill bounded key-ordered pages, then drain changes after the snapshot
  boundary into PostgreSQL with an idempotent checkpoint.
- Compare per-table counts and canonical ordered digests. Credentials and
  private data never appear in output.

### M2-C — Behavior verification

Status: accepted in Next.

Run Auth through the PostgreSQL adapter in comparison mode and verify login,
invite gating, OTP, sessions, JWT/JWKS, Human Profile, restart, and transient
database failure. D1 remains the writer.

### M2-D — Auth cutover

Status: accepted in Next. D1 is fenced, PostgreSQL is authoritative, and the
Worker binding is removed. The historical D1 resource is not a runtime
fallback.

Fence D1 writes, drain the last boundary, record the final receipt, then deploy
PostgreSQL as the only Auth reader/writer. D1 stays read-only for the verification
window and is then unbound. PostgreSQL failure does not fall back to D1.

### M2-E — DO control facts

Status: user preferences are PostgreSQL-authoritative. Space, membership,
Channel catalog, ACL, billing, and message facts have a lossless PostgreSQL
archive and typed backfill targets. The remaining work is to move each complete
runtime command closure before changing its authority selector.

Migrate preferences first, then move the Space/Channel control closures in the
order established by their command-transaction matrix. Each closure repeats
shadow, verification, fence, cutover, and retirement.

The preference shadow flow is deliberately one-way:

1. The Worker admits each DO preference write only while PostgreSQL says the
   global domain phase is `shadow`, and starts that user authority's local
   journal before dispatching the write.
2. The operator discovers only active directory-bound user authorities,
   backfills bounded key-ordered pages, drains per-source events, and compares
   canonical counts and digests.
3. Cutover changes the global phase to `fenced` before fencing every source,
   performs a final drain and comparison, and records `source_fenced`.
4. PostgreSQL product behavior must pass before `target_authoritative` is
   recorded. PG failure never falls back to a DO preference row.

## Auth translation

- D1 dates become UTC `TIMESTAMPTZ`; integer booleans become PostgreSQL
  `BOOLEAN`; identifiers and nulls are preserved.
- Email and Human handle uniqueness becomes case-insensitive. The backfill
  reports collisions instead of resolving them automatically.
- Better Auth maps to the `control.auth_*` tables through cache-disabled
  Hyperdrive. xMatrix-owned Auth queries use a PostgreSQL repository rather
  than D1-shaped wrappers.
- `control.authority_migration_receipts` records boundary, counts, ordered
  digest, source/target, previous receipt, and exact application revision. It
  is evidence; the deployed authority flag selects the writer.

## Main rollout contract

- PostgreSQL schema and code contain no `next` resource names.
- Authority flags are domain-specific and default to the existing authority on
  `main` until that environment completes its own verification.
- Backfill/comparison commands take explicit environment and database targets;
  Next receipts cannot authorize a Main or production cutover.
- Every M2 stage is independently mergeable into `main` with its new authority
  path disabled.
- Before cutover, rollback keeps the old authority. After cutover, rollback
  keeps PostgreSQL authoritative unless a reverse-sync migration is run.
