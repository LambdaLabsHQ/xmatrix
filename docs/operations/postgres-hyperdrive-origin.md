# PostgreSQL origin behind Hyperdrive

The Hub reaches production PostgreSQL only through two cache-disabled
Hyperdrive configurations (`RELAY_POSTGRES`, `RELAY_POSTGRES_SHARD_1`). Since
2026-10-06 the origin is a managed PlanetScale Postgres 17 cluster in the same
AWS region as the Worker placement hint. It is a deliberate single-node cluster
(no replicas), so this page covers what keeps it healthy without HA.

## Connection budget

The origin allows 50 connections, 3 of them reserved for superusers. Both
shards share it, and the provider's own sessions (`pscale_admin`,
`pscale_exporter`) hold about 4. Hyperdrive limits are soft: on 2026-10-08 the
primary pool held 36 connections against a limit of 30, and with 30 + 10
configured the origin refused every other login (`remaining connection slots
are reserved for roles with the SUPERUSER attribute`), which failed release
verification and Hyperdrive's own reconnects. So
`scripts/production-hyperdrive-prepare.mjs` pins them at 24 (primary) and 8
(shard 1): an overshoot of that size still leaves room for migrations,
release verification and operators. Any other Hyperdrive configuration
pointing at the same origin counts against the same 50; delete retired ones
rather than leaving them idle.

To see who holds the origin, read `pg_stat_activity` grouped by `usename`
(the runtime secret can, while a slot is free) and sum
`hyperdrivePoolSizesAdaptiveGroups.max.currentPoolSize` over `poolShardId` per
minute: the per-shard maximum alone hides the overshoot.

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

Billing summaries use the client's independent `single_read` statements on one
request session, including membership and placement checks. Each lost response
may recover once on a fresh checkout; repeated loss still fails the request.
These reads retain READ COMMITTED's per-statement snapshots without a read-only
BEGIN/COMMIT. Provider billing mutations still summarize inside their owning
transaction and retain their existing commit reconciliation.

Unclassified runtime socket database failures report the client's bounded
failure evidence under `runtime.database`: operation, shard, statement mode,
phase, named query, SQLSTATE and elapsed time. The Sentry issue reader exposes
these fields and the response's diagnostic reference. Deployed `index.js`
frames retain source-map resolution; driver messages, SQL details and causes
are excluded. Exact documented Hyperdrive `58000` messages map to finite
internal, pool-acquisition or connection-refused labels; other text stays
unclassified. A missing code or capture-boundary stack remains insufficient
to diagnose an outage or authorize a transaction replay.

Message authority failures also explicitly report the original exception and
bounded database evidence, rather than relying on console serialization.
Slow execution-report owner and Channel lifecycle admission locks sample the
live wait edge before a lock timeout removes it: only fixed waiter/blocker
owner categories, state, wait type and capped transaction age are retained.
The two paths share one additional diagnostic connection per isolate, with
250 ms connection/query deadlines; fast locks open none. An unavailable or
busy sampler preserves the original error and existing recovery rules.

Hyperdrive pools in transaction mode. Session state does not survive between
transactions: use transaction-local settings (`set_config(..., true)` or
`SET LOCAL`). The Better Auth adapter does not `SET search_path`. Its tables
are `control.auth_*` (`packages/hub/src/auth-postgres-models.ts`), and the
origin role cannot take `ALTER ROLE ... SET`. Transaction-scoped advisory
locks (`pg_advisory_xact_lock`) work, but Hyperdrive documents them as
unsupported; do not add session-level ones. `max_prepared_transactions` is 0, so
`PREPARE TRANSACTION` is unavailable (see
`docs/design/dingtalk-cross-database-effects.md`).

## Weekly index recommendations

The 5–12 October 2026 PlanetScale report recommends removing the archive's
redundant object index twice. Migration 0174 already retired that entire table
and its indexes on both databases. Its COPY traffic in the report is historical
import work, not a recurring application query. Migration 0164 already restored
the machine-command claim and dispatch indexes after hostname retirement;
verify their presence before adding overlapping provider recommendations.

The 26 October report's `machine_run_routes (owner_user_id, machine_id, …)`
recommendation was the same hostname retirement again: dropping `host_id` in
0137 silently dropped the Machine Run route index and the Launch delivery index,
so every daemon report and reconnect scanned those tables. Migration 0220
rebuilds both without the column. `migration-index-drift-postgres.test.mjs` now
applies every migration in order and fails when an index disappears without a
migration naming it; its short accepted list records each historical loss and
why nothing reads by it.

Migration 0184 adds an ordered partial index for unfinished launch cancellations
on `(channel_id, updated_at, run_id)`. The existing Channel open-work index serves
preparation and due-time reads but retains completed aborts and cannot supply
cancellation order. Keep both: the cancellation index excludes completed aborts,
while the existing reconciliation still checks that no Run committed before
releasing a reservation. No lifecycle or authorization behavior changes.

Verify both logical databases after release with `pg_stat_user_indexes` and
`EXPLAIN (ANALYZE, BUFFERS)` on the cancellation read in a bounded read-only
transaction. Check ordering and buffer work with accumulated completed history
using `registration-launch-cancel-index-postgres.test.mjs`; do not infer future
weekly CPU or latency improvements from a single empty-queue probe.

## Watching the pool

`hyperdrivePoolSizesAdaptiveGroups` in the Cloudflare GraphQL API reports
`currentPoolSize`, `maxPoolSize`, `waitingClients` and `availablePoolSlots`
per configuration and pool shard. `waitingClients` above 0 for more than a
minute means the origin connections are held too long; compare with the
`session` points in the substrate observability dataset
([connectivity breaker](postgres-connectivity-breaker.md)).

Authentication database operations use the `postgres.auth` family and retain
their code-defined operation in `blob11`, including `auth.account-revocation`.
Use `database_phase_pool_checkout_v1` and the session's checkout duration to
distinguish connection failures before SQL from a slow revocation query.
Older deployments grouped these operations as `other`; their operation cannot
be recovered from that label alone.

Account-deletion observations use the `postgres.account-deletion` family and retain
the code-defined operation in `blob11` (for example `account-deletion.pending`
or `account-deletion.claim`). Opening failures retain `phase.begin` and
`database_phase_begin_v1` before any business SQL runs. Query and session
points use the same family; no account or request identities are labels.

The account-deletion pending-job scan is one lock-free `single_read`: it does
not open a transaction or wait for COMMIT after obtaining its candidates. A lost
read gets the existing single retry on a fresh checkout; a second failure still
fails maintenance. Claiming and advancing a deletion remain explicit write
transactions with their existing lease and commit-unknown behavior.

Automation catalogs (`list`, page lists, cross-Space lists and `get`) run each
lock-free SELECT, including access checks, as a placed `single_read` on a
request-local session. A lost response destroys that checkout and retries the
statement once; a second loss or an answered database error still fails the
request. Each statement checks the placement fence and takes its own snapshot,
as the previous READ COMMITTED transaction did. Page visibility and private
event redaction still finish before any catalog result is returned. Automation
mutations and their commit reconciliation remain explicit transactions.
Channel catalog pages, counts, participant reads and exact-ID resolution use
the same per-statement recovery, with authorization still checked by their SQL.
Registration quota projections, both authorized batches and owner refreshes,
also use one `single_read` each (HUB-AQ). A lost response retries once on a fresh
checkout without BEGIN/COMMIT; repeated loss still fails. Registration keys,
pool joins, reading freshness and quota observation writes are unchanged.

Sentry event claiming (including receipt cleanup), Gmail route cleanup and
claiming and fenced completion, and Bot room expiry cleanup (Google Chat, Feishu, Telegram and Teams)
each replay once on a fresh request session after a connection timeout
or lost response before COMMIT. These transactions have no provider or delivery
side effects. The failed session closes first; locked candidates use SKIP LOCKED,
and unfinished work remains eligible on a later pass. A second failure, an open
connectivity breaker or an answered database rejection still fails the pass.
Once COMMIT has been sent, connection loss is an unknown result: no immediate
replay occurs, and the next bounded cleanup pass or expired-lease recovery
reconciles it. Provider calls and notification delivery are outside the replay.

Machine daemon commands (including enrollment) and the database mutation in
Run lifecycle and execution reports use the same one-replay boundary. Each
attempt owns and closes a new session, including when its repository received
a request session. Replays restart the command's locks, placement fence and
authority checks; observed hostname state is local to each attempt. Runtime
route publication, socket wakes and Channel notices remain outside that boundary.
COMMIT uncertainty still escapes to the existing command receipt and execution
report reconciliation; it never triggers an immediate replay. This repairs the
HUB-AN/AP recovery gap without attributing the underlying transport stall.
Lock-free page search uses per-statement `single_read` recovery, including its
membership and accessible-page checks (HUB-99).
Channel detail reads use the same request-local, per-statement recovery for
the authorized Channel row, live/resting Instance presence and visible Human
members (HUB-AR), as the catalog already does. Each read checks its placement
fence; the Channel row's shared capability predicate checks current membership
and grants again if its response is lost. There is no enclosing BEGIN/COMMIT
or cross-statement snapshot guarantee. A second lost response or an answered
SQL/domain error still propagates.

Page section awareness and blame use the same independent reads for membership,
page access, revision metadata and bodies (HUB-AS). Each lost response can recover
once on a fresh connection, with the placement fence and any retried access query
checked again. Document comparison runs after the read session closes. Derived
section changes and blame still use separate best-effort transactions: their
share locks and body hashes protect against a concurrent purge. These cache
writes do not become `single_read` statements.

Sentry recovery claims try the same transaction advisory capacity lock that
webhook admission takes exclusively. A busy app returns no jobs for that pass,
without changing attempts, leases or receipt cleanup; the minute recovery wake
tries again. Successful claims still serialize the eight-active-lease bound.
Webhook admission retains its waiting lock to enforce receipt and backlog bounds;
database failures other than a busy try-lock still propagate normally.

Gmail pending notification IDs use one lock-free `single_read`; retrying a
completion never reruns provider calls or delivery. Its lease ID and expiry
remain the write fence, and an unknown completion commit retains cursor/lease
reconciliation.

Scheduled failures send one Sentry event with a fixed task tag, including
stackless platform errors and transient PostgreSQL failures. The database client
retains at most four failed attempts across its bounded retry, causes and
aggregate shard failures: static operation, shard, statement mode, phase, query
name, normalized error code and duration. `read_issue` exposes only that validated
projection from Sentry's event context; SQL, parameters, request IDs, credentials
and arbitrary extra fields remain omitted. Two SQL/BEGIN failures show retry
exhaustion; a COMMIT phase indicates uncertainty and must not authorize replay.
A missing database projection means the task failed outside an observed database
call; use the task and mapped stack rather than inferring a database outage.

Each new failure also snapshots its owning session's wall, queue, checkout,
BEGIN, cumulative SQL, longest SQL and COMMIT durations, plus attempted round
trips and queries. The issue reader exposes this bounded numeric projection
beside each failure; historical events without it remain readable. Compare the
failed round trip with the session's other stages before calling it an isolated
stall (HUB-AV exhausted its SQL retry in BEGIN). Snapshots precede rollback and
retry and never combine progress from separate replay sessions. Single reads
that recover within one session retain that session's cumulative progress.
These timings include Worker-local waiting and do not prove network or server
latency. There is no extra SQL, broader retry or COMMIT replay.

## Agent lifecycle locks

Execution-report owner queries that remain in flight for 500 ms (or half the
configured lock timeout, if shorter) sample `pg_blocking_pids` and
`pg_stat_activity` through an independent read-only statement. A lock timeout
has already removed its wait edge, so sampling after that error cannot recover
the holder. The opening round trip obtains the origin backend pid without an
extra query; it is used only as the sample's parameter and never reported.
The sampler has 250 ms connection and query deadlines and one concurrent slot
per isolate. Fast queries cancel the timer, and the request awaits any sample
it started. Busy, missing and unavailable results are explicit, not proof that
there was no contention. The sample reports at most four blockers, their fixed
owner category, state, wait class and capped transaction age; no SQL, ids or
parameters. The execution-report category can reveal an earlier report still
idle in transaction, but does not alone prove it was this request's first
attempt. An original timeout or rejection remains authoritative; existing
pre-COMMIT recovery and unknown-commit reconciliation are unchanged.

Placement directory single reads use the same diagnostic capacity after 500 ms
(HUB-B1). Because transaction pooling provides no stable backend pid before a
single read, each attempt prefixes its SQL with a fresh random diagnostic marker.
The independent sample matches that exact prefix in active `pg_stat_activity`
rows and returns the same bounded state, wait class, transaction age and blockers
as `queryWait`; the Sentry reader labels it `Database read wait`. SQL, the marker,
parameters and backend identities never enter failure evidence. Each retry has
its own marker. `sampled` can distinguish an origin lock wait from another wait;
`missing` means no active match at the sample instant, not proof the SQL never
arrived or that Hyperdrive caused the loss. `busy` and `unavailable` likewise
cannot establish absence of origin work. Fast reads open no extra connection,
and diagnostic failure preserves the original error and single retry bound.

First-reply observation runs after the Agent message commits. It checks current
Channel access without a lifecycle row lock (`runtime_check`): it starts no work
and updates only the connected Launch whose `first_reply_at` is still null.
Concurrent appends and lifecycle commands therefore cannot block the observation
on the Channel row; repeated replies retain the first timestamp.

Agent message preparation, observed-head and receipt reads, content reads and
Channel access checks validate current Run and registration snapshots without
holding lifecycle rows. Preparation never authorizes a later send. Commands
that write acquire the Run's source and target Channel lifecycle locks in
Channel-id order before locking the Run, then re-read its credential and
registration authority. This matches Human stop messages (Channel before Run),
avoids shared-lock upgrades, and prevents reciprocal cross-Channel writes from
locking the same Channels in opposite orders. Stops and revocations committed
after preparation still refuse publication.

Instance connection claims discover their owning Channel without holding the
Run, take its exclusive lifecycle lock, then re-read and lock the current
Run/Instance before registration admission. A changed Channel refuses the
claim. Capacity-retry control and registration withdrawal preparation take the
same Channel lock before locking their Runs. These paths therefore order
behind stop messages and appends, including initial
admission, without upgrading a shared Channel lock while holding the Run.
Stops and registration withdrawals committed during the wait remain effective
(HUB-AW); reconnect cannot revive the stopped execution.

## Failover and restarts

On a single-node cluster a provider restart or maintenance drops every origin
connection. Hub requests fail with retryable 503s, the connectivity breaker
opens, and single reads retry once on a fresh connection. Initial transport
checkout failures and lost read responses share that one recovery attempt;
neither an explicit database rejection nor an open breaker triggers a retry.
Both failed attempts retain their bounded phase evidence. This never replays
an explicit transaction or a COMMIT with an unknown result. When the origin is
back but Hyperdrive keeps failing (stale pooled connections), restart the
configuration's pool from the Cloudflare dashboard (Hyperdrive → configuration
→ Danger zone → restart), then confirm `GET /health/postgres` returns 200 and
`waitingClients` returns to 0. Keep transactions short: long ones delay a
provider failover or restart.

## Channel catalogue counts

A Space-scoped control request (including the Channel list) with no placement
answers `space_not_found` (404), before opening a shard transaction. The Agent's
subsequent cross-Space grant lookup preserves that refusal. A moving or
blocked placement still answers retryable `space_placement_unavailable` (503).
Malformed placement rows and database failures remain unexpected failures;
a missing caller-selected Space is not a storage contract violation.

Catalogue counters aggregate the selected principal's attention once per Space,
then join the per-Channel result to the freshly authorized Channel set and read
cursors. A Channel needs attention when any declared wait still stands or its
maximum attention sequence exceeds the cursor. Keep `BOOL_OR` over all waits:
the newest attention row alone can hide an older acknowledged question.
Unread speech retains its separate message predicate, so activity-only entries
do not make a Channel unread. Grouping does not grant access to hidden Channels
or another principal's attention, and each Channel counts once.

For query-cost work, compare old and new SQL inside a read-only repeatable-read
snapshot. Check identical counter results, then inspect repeated
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans and logical block accesses;
client elapsed time also includes network latency. Use the existing query
observations (`postgres_substrate_observability_v4`, `blob1='query'`, query name
in `blob9`) to identify production frequency and tail latency. The overview
already shares one metadata scan; adding a timestamp index cannot remove its
all-time exact counts by itself. PostgreSQL table statistics are estimates,
not exact row counts.
