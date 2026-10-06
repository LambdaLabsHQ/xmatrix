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
