# New-user funnel

Run `node packages/db/scripts/new-user-funnel.mjs <from UTC> <to UTC> POSTGRES_SHARD_1_RUNTIME_DATABASE_URL`
with runtime PostgreSQL credentials (`POSTGRES_RUNTIME_DATABASE_URL` and each
additional shard named by its environment variable). Through xMatrix:

```sh
xmatrix secret exec --secret postgres-runtime-database-url --secret postgres-shard-1-runtime-database-url -- \
  node packages/db/scripts/new-user-funnel.mjs 2026-10-17T07:00:00Z 2026-10-18T07:00:00Z POSTGRES_SHARD_1_RUNTIME_DATABASE_URL
```

It answers how far each account registered in `[from,to)` got, and what
stopped it. The window is at most 31 days and 2,000 accounts. It is read-only
and metadata only: a person is a 10-character hash of their id; no name,
email, message, page or prompt text is printed. A turn failure is kept as its
class (`harness_signed_out`, `usage_limited`, `turn_failed`), a failed start as
its operation-failure code or run phase.

Each person's `stage` is the furthest of `registered`, `space`, `machine`
(a Machine was enrolled), `agents` (an agent registration exists), `message`
(the person sent a message of their own), `reply` (a launch in their Space got
a first reply) and `page` (they are credited with a Page). The output also
gives `reached` (people at or past each stage) and `stoppedAt` (people whose
furthest stage it is), their first device and platform, the agents installed
on their Machine with each sign-in state, and the failures.

What only the person's screen sees (the steps of bringing agents in, which
starter card they chose, why the desktop App could not start its service) is in
the diagnostics dataset; queries are in `docs/architecture/first-space.md`.

Use it for decisions, not for watching individuals: report counts and failure
codes, and do not look up who a hash is.
