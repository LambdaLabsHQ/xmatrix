# PostgreSQL connectivity breaker

Each Hub isolate keeps a small circuit breaker per physical shard
(`packages/db/src/connectivity-breaker.ts`). It exists for one failure mode:
the network path between Hyperdrive and the origin stalls (2026-10-05: origin
reads went from ~3 ms to 40–1300 ms for 15–30 minutes). Without it, every
request waits out its full connect or first-statement deadline, the Hyperdrive
pool fills with stalled sessions, and recovery is slower.

## Behavior

- **Counts only path failures**: connect/read timeouts, dropped connections,
  `ECONN*`/`ETIMEDOUT`, SQLSTATE class 08, `53300`, `57P03`. Serialization,
  deadlock, constraint, server statement timeout and contract errors are
  per-request and never count.
- **Opens** after 5 consecutive path failures within 10 s. While open, new
  sessions fail before any checkout with `database_circuit_open`.
- **Probes** once per cooldown (5 s, doubling after each failed probe, capped at
  30 s). Any completed statement closes the breaker.
- **Never authority**: the state is per isolate, lost on eviction, and only ever
  turns a request into a retryable 503. Sessions that already hold a connection
  are not touched, and commit-unknown handling is unchanged.

## What clients see

Retryable PostgreSQL failures answer `503` with `retryable: true` and a
`Retry-After` header: the breaker's remaining cooldown when it refused, else
2 seconds. Non-retryable defects stay `500` without `Retry-After`.

## Diagnosing a refusal

A refusal is not another failed connection attempt. Query and session telemetry
preserve `DATABASE_CIRCUIT_OPEN` rather than collapsing it to `DATABASE_ERROR`.
The refused checkout's query point in `postgres_substrate_observability_v4`
keeps the requested operation in `blob11` and adds:

| Slots | Meaning |
| --- | --- |
| `blob12` | `open` cooldown or `half_open` probe in flight |
| `blob13` | Last counted connectivity failure's normalized code |
| `blob14`, `blob15` | That failure's code-defined operation and query/phase name |
| `double5`, `double6`, `double7` | Retry delay, age of that failure (ms), counted failure streak |

These additional slots apply only to refused **query** points; session timing
slots retain their existing meanings. Unknown or malformed dimensions collapse
to bounded buckets. No request ids, SQL, parameters, result rows, identities or
connection strings are recorded. A successful statement clears the evidence
along with the breaker; each rejection carries a snapshot from its own isolate
and shard, so a coincident failure in another isolate is not mistaken for its
cause. The last counted failure identifies the opening or failed probe path,
not a complete trace of every failure in the streak.

For the next HUB-9M event, select `blob6='DATABASE_CIRCUIT_OPEN'` query points
around its UTC timestamp. Compare the refused operation with the last failure's
operation, phase, code and age, and distinguish cooldown from an in-flight
probe before changing a business path's recovery. A refused session performs
no SQL; pre-commit recovery remains bounded to its existing one replay, and
unknown commits still require reconciliation.
