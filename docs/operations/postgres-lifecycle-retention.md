# PostgreSQL lifecycle retention

The production lifecycle maintenance broker runs daily and dispatches the
existing bounded executor from the latest successful immutable production tag.
For an immediate report, dispatch `production-postgres-lifecycle-maintenance-request.yml`
with `dry_run=true` and `max_rows=10000`. Inspect its secret-free JSON artifacts
before dispatching the same broker with `dry_run=false`.

The executor visits the primary database and every configured shard. Deletion
uses batches of at most 1,000 rows, a per-relation ceiling (10,000 by default,
100,000 for the existing daily schedule), a shared time budget, a five-second
statement timeout and `FOR UPDATE SKIP LOCKED`. Each batch commits separately;
repeating a pass resumes from the remaining eligible rows. Before/after reports
include row counts, relation sizes and capped eligibility counts, never content.

Expired idempotency keys, sequence reservations, Agent message executions,
connector install attempts and scoped command replays retain their existing
expiry rules. Readers already refuse expired receipts. Their cleanup was
implemented before the credit rollout; it must be verified through execution
receipts rather than assumed absent from a large table size.

Scoped command replays keep 30 days, except the two high-volume daemon
streams, which keep one day: Machine daemon `report` commands
(`machine-daemon-control`) and Run snapshots (`machine_run_lifecycle` for
`machine_run_snapshot`). On 2026-10-16 those two were about 85% of the 1.5M
replay rows and most of the 3.1 GB table. A report from an older connection
is refused by the epoch fence before its replay is read, every report has a
fresh command id, and the snapshot head refuses an older registry sequence,
so neither replay answers anything after the sender's own prompt retries.
Rows written before the change expire on their original 30-day schedule.

Expired sign-in sessions (`control.auth_sessions` past `expires_at`) are
removed in the same bounded batches. Every sign-in check already refuses them;
on 2026-10-17 there were about 50,000 such rows that nothing had ever cleaned.
Live sessions are never touched by maintenance; a person ends their own from
Settings, and signing out ends the one they used.

Financial receipts (`data.space_credit_purchases` and
`data.paid_call_receipts`) are not TTL replays. Preserve them for the lifetime
of their Space; they move with the Space and are removed only by its existing
explicit purge. Removing them through maintenance would allow a payment or
paid upstream request to be counted twice.

## Outbox

`data.outbox` currently retains transaction publication envelopes. No production
consumer leases or acknowledges this PostgreSQL table; message delivery,
command recovery and shard movement read their own current authorities. The
outbox remains part of a Space's move snapshot and is not a substitute for
canonical messages, Pages, mutations, audit records or billing settlement
receipts.

Keep at least **35 days** of unconsumed envelopes. A row is eligible only when
all three timestamps (`available_at`, `created_at`, `updated_at`) are older than
35 days, its status is `pending`, it has zero attempts, and no lease exists.
The existing delivery index bounds the oldest-first scan. Leased, attempted,
failed and delivered rows are preserved; a future consumer needs a separately
documented acknowledgement and retention contract before changing this rule.

The artifact's `deletedRetainedOutboxRows` is the exact removal count. A zero
count is a valid outcome when every envelope is still inside retention.
PostgreSQL reuses freed space; relation bytes do not immediately shrink.
Do not run `VACUUM FULL`, truncate tables or delete user content as part of
this procedure. Backups and point-in-time recovery remain the production
database's recovery path for maintenance errors.
