# Automation execution cancellation

An Automation execution deadline cancels execution authority immediately when its
scoped scheduler services the deadline. Stop delivery or acknowledgement never
holds the scheduling slot open. The default execution deadline remains 30 minutes.
The next occurrence follows the existing cadence; cancellation does not pause,
resume, edit, or immediately rerun the Automation.

The Human owner can cancel one dispatched execution with:

```sh
xmatrix automation cancel-execution <automation-id> --run-id <exact-run-id> --json
```

The equivalent authenticated request is
`POST /api/automations/:automationId/cancel-execution` with `{ "runId": "..." }`.
The API accepts no owner, machine, execution key, status, or terminal evidence from
the caller. It requires the Automation's Human owner and current Channel access. Agent
principals and other owners are rejected. Existing clients and Hubs retain their
existing commands; this new endpoint requires PostgreSQL execution authority.

The Automation authority resolves current Space placement and epoch, checks
Automation/occurrence/Run ownership, and calls the Runtime-owned cancellation transition
inside the same transaction as the occurrence update. It sets Run status `failed`
with `executionCancellation.reason` (`owner` or `timeout`), and occurrence status
`cancelled` with `scheduled_run_cancelled` or `scheduled_run_timed_out`. These are
authoritative cancellation facts, not assertions that an operating-system process
has died. Existing live-Run authorization rejects subsequent writes, reads requiring
live execution, reconnects, and Focus publication by the cancelled Run.

The exact historical Run id is the cancellation fence. There is no "latest"
selector that can race a new occurrence. Repeating cancellation is idempotent;
reusing an idempotency key with different input conflicts. An already completed
execution is not rewritten as cancelled. The original route and execution key are
retained only in the owning Runtime record.

Physical cleanup is independent and durable in
`executionCancellation.processCleanup`. It starts `pending`, receives at most eight
exact-execution stop attempts, and uses exponential backoff capped at 15 minutes.
Missing routing becomes `unroutable`; exhausted acknowledgement retries become
`unconfirmed`. Neither state reopens occupancy. Only an authenticated, route- and
execution-matched daemon exit or successful stop marks cleanup `confirmed`.
Late spawn, exit, and stop reports cannot revive the Run, overwrite cancellation
with success, or change a later execution's outcome. CLI/API output and Automation reads
expose cleanup state separately from cancellation, without exposing execution keys.

This intentionally replaces the previous contract that held an occurrence until
physical stop confirmation. Legacy unfinished timeout rows, including exhausted
stop retries, are cancelled by the same deadline path. No incident-specific Run
completion or direct database repair is required.
