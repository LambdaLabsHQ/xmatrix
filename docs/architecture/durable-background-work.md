# Durable background work

Status: proposed (2026-10-21). The design review (Claude, codex) converged; nothing
is implemented yet. The physical resource bound, executor isolation and failure
recovery are gated on the experiments below. Until they pass, the only resource
promise is controlled dispatch with soft admission.

## Why

The Hub's background work runs from one minute cron that starts ten tasks at
once: account and channel deletion, Sentry receipt recovery, Gmail notifications,
the harness release watch, machine load history and four connector cleanups.
Each task finds its own work by scanning, holds its own leases and retries, and
reports its own failures.

Three things are wrong with that mechanism, and none of them is fixed by running
the same tasks faster or closer to the database:

- **Slowness becomes failure.** Every statement has a hard client deadline. When
  a dependency is slow, the task fails for that minute, the failure is reported,
  and an Agent is sent to investigate. XMATRIX-HUB-90 was one such minute: the
  Gmail claim waited 5 s for a response and the whole drain failed.
- **Correctness and capacity depend on the deployment.** Placement moves only
  fetch handlers, so the cron runs wherever Cloudflare starts it (MIA or ATL in
  production) while PostgreSQL is in Singapore. Its transactions held origin
  connections across 175-490 ms round trips: about 3.5% of the Hub's database
  sessions accounted for a third of its time in SQL and COMMIT, all at the top
  of the minute.
  Another deployment will place things differently.
- **Timing is buried in infrastructure.** When to run is business logic (a
  mailbox poll, a renewal, a grace period, a retention window), but here it is a
  cron period plus ten private copies of claim, lease, backoff and reporting.
  Nothing can carry new, unusual or heavy business timing without adding an
  eleventh copy.

## Goals

- **G1 Decoupled.** Business code declares work and handles it. The mechanism
  knows no business, and neither depends on placement, location hints or which
  data centre runs what.
- **G2 Timing is business data.** Work is accepted in the same transaction as the
  business write that causes it.
- **G3 Any business, any load.** The number of timers, their frequency, execution
  time and external calls can all grow without changing the mechanism.
- **G4 Slow is normal.** When a dependency is slow, work finishes later. It is not
  lost, an execution is started at most once per attempt token, resources stay
  bounded and nothing retries without limit.
- **G5 Health is progress.** Alerts fire when work falls behind its deadline or
  stops moving, once per incident; defects are still reported. Transient errors
  are telemetry.

## Three parts

| Part | Decides | Owned by |
| --- | --- | --- |
| Business | What to do and when: timing rules, reschedule, cancel, merge, validity, whether a retry is safe, the lag deadline | Each domain |
| Execution | That accepted work is found, started once per token and settled correctly | The engine |
| Resources | How much runs at once: executor slots, database phases, external dependencies, fairness, reserves | The engine's resource entry |

A timer is only one way to trigger work; events and manual triggers use the same
execution protocol. Not every domain has to become a timer.

## Contracts

These hold on any platform.

### Intent

- An intent is identified by `(scope, kind, work id)`. The scope is `space:<id>`
  or `system:<kind>` and is derived by the server from where the business row
  lives, never from a payload. The intent also records its version and, for a
  Space, the placement epoch.
- An intent is written in the same transaction, on the same shard, as the
  business write. A committed business change with no intent, or the reverse,
  cannot happen.
- Business deadlines (a mailbox's next poll, a watch renewal) stay in the
  business tables. The intent's wake time is a projection the same repository
  method maintains in the same transaction, and each kind can rebuild it.
- An intent carries two plans: the one a running execution consumed and the one
  waiting to run. Every business change increments the version:

  | Operation | Pending plan |
  | --- | --- |
  | `set(T)` | becomes `T` |
  | `advance(T)` (no later than `T`) | `least(pending, T)`, or `T` if none |
  | `postpone(T)` (no earlier than `T`) | `greatest(pending, T)` if one exists; otherwise none |
  | `cancel` | cleared; the intent is marked cancelled and stops authorizing further execution |

  A cancelled intent is deleted only after its execution has ended and any
  uncertain outcome is reconciled.

### Execution protocol

PostgreSQL holds the only state. Every transition is one statement with
server-side lock and statement limits.

| Step | Effect |
| --- | --- |
| claim | A due intent gets a lease token, an unstarted lease deadline and a dispatch attempt. It is persisted before anything is sent. |
| start | One compare-and-set from unstarted to started for that token, extending the lease to the execution deadline. A second start for the same token, or a start after the intent was claimed again, matches no row and the message is dropped. |
| finish | Settles by intent version and token. If the version is unchanged, the outcome applies. If it changed, the execution settles only its own attempt and receipt: the new plan stands as the business left it, and the old execution's next time is not merged into it. |

An execution reports one of:

| Outcome | Meaning |
| --- | --- |
| `done` | The plan it consumed is satisfied. |
| `defer(T)` | Run again at `T` (the business's own next time). |
| `continue` | A bounded step finished; run the next step now. |
| `uncertain` | An external effect may or may not have happened. |
| `permanent` | The work cannot succeed; park it for a person. |

What each outcome means for the business, including what follows `uncertain`, is
the kind's contract.

Failure windows and who recovers:

| Window | Recovery |
| --- | --- |
| Business committed, the waking notice never sent | The intent is in its partition's index; discovery finds it (see adapters). |
| Claimed, never dispatched | The unstarted lease expires; the intent is claimed again. Not counted as a business attempt. |
| Dispatched twice, late or out of order | Only one start per token succeeds; stale tokens match nothing. |
| Started, then the executor vanished | The execution lease expires; the next claim sees a started attempt with no result and applies the kind's contract for unknown outcomes. |
| Finish response lost | If it committed, the work is settled; if not, as above. |

The lease fence covers only the engine's receipts and results. Business writes
made by a handler carry their own version or fence checks; an expired execution
can still reach the business tables unless the business checks.

### Side effects

- The engine guarantees at-least-once delivery, one start per token and that an
  expired execution cannot settle. It does not make external effects
  exactly-once, and it does not infer from an error whether an external request
  took effect.
- Idempotency across retries uses a stable business operation id (a notification
  id, a delivery digest, a control id), never the attempt token.
- Each kind declares its effects: **safe** (replay is harmless), **reconcile**
  (it can find out whether a previous attempt took effect) or **at-most-once**.
  An `uncertain` outcome is never replayed automatically: it is reconciled, or
  parked for a person.
- Cancel stops further authorization. It does not undo what already happened, and
  a request already sent cannot be recalled by a lease.

### Counting, backoff and lag

- Admission refusals, dispatch failures, business attempts (started) and
  unknown outcomes are counted separately. Only business attempts count toward a
  kind's limit.
- Infrastructure failures (no admission, database unavailable, dispatch lost)
  back off with a cap and keep the intent discoverable. They never park it and
  never exhaust its attempts: a day without a database does not make a periodic
  cleanup disappear.
- Each kind declares its validity (expired work is dropped and recorded), whether
  intents merge, which failures are permanent, an optional business attempt
  limit and its lag deadline.
- Lag is measured from the earliest unmet planned time. Retries and reschedules
  caused by infrastructure do not reset it; only an execution that consumes that
  plan does.

### Resources

- Executor slots, database phases and each external dependency have separate
  budgets. A handler waiting two minutes on an external API holds an executor
  slot, not a database permit, connection or transaction.
- Handlers get no session factory. They call the resource entry
  (`ctx.db.transaction`, `ctx.db.read`, and the equivalents for external
  dependencies); each call is admitted, opens what it needs, runs one bounded
  phase and releases it. A handler may run many phases across many resources.
  Repositories used by handlers are built on this entry, and a static check
  forbids handler modules from importing a database factory.
- The database budget is per physical database instance, not per logical shard:
  the primary and shard 1 share one origin.
- Work is shared fairly by scope. One Space with a million due intents and
  another with one new intent are served alternately: each pass takes at most a
  small number per scope, and each scope has an in-flight limit. System work has
  a guaranteed share.
- The engine's own steps (claim, start, renew, finish) have reserved capacity
  inside the same physical budget. Reconcile functions are metered by what they
  actually call; being part of recovery does not grant business code the
  reserve.
- When inflow exceeds capacity, dispatch stays bounded: work is merged or
  refused at the entry, and the caller can tell reliably accepted work from
  refused work. Adding consumers is not a throughput guarantee.

### What is promised

- Healthy and unsaturated: committed work is discovered within a target delay
  and started promptly.
- Saturated, or a dependency slow or down: accepted work is kept, lag is visible
  and other scopes keep being served. Resources are bounded only to the extent
  experiment E1 proves; until then, admission is a soft limit.
- Never promised: unlimited throughput, exactly-once external effects, or that
  an expired lease means its SQL has stopped.

## Platform adapters

The current choices for Cloudflare and PostgreSQL. Each can be replaced without
changing the contracts above.

- **Intent store.** One table per physical shard, indexed by partition and wake
  time. Server time is authoritative.
- **Waking.** Intents are hashed into partitions. Each partition's driver is a
  Durable Object whose alarm is the earlier of its next wake time and a bounded
  discovery interval, so a missed notice costs at most that interval while the
  control plane is healthy. Drivers only claim and dispatch; they never run
  business. The minute cron only checks that every driver's alarm exists; it
  reads no database and runs no business.
- **Execution.** Light kinds run in a shared executor. CPU-heavy kinds run in a
  separately deployed executor Worker, never beside scheduling, the control
  plane or WebSocket service. One invocation per execution, or a batch of one,
  is not by itself proof of isolation: a Worker isolate can serve several
  requests at once.
- **Database entry.** Each transaction re-checks its admission before it begins
  and runs with server-side transaction, statement, lock and idle limits.
- **Health.** Lag, parked and uncertain counts per kind. External monitoring is a
  replaceable receiver; Sentry Crons is today's choice, not a dependency.

### Change to entity coordinators

[Entity coordinators](entity-coordinators.md) say a coordinator never finds work
by scanning and an alarm is never a heartbeat. This design changes both, on
purpose:

- Drivers discover work from a bounded, indexed range of intents in their own
  partition, not by scanning business tables.
- A bounded discovery interval replaces "the writer's caller will retry", which
  is not a general guarantee: a writer can commit and die with no one to retry.
- The cron watches the fixed set of drivers. It is not a work coordinator, and
  there is still no global serial executor.

## Experiments

These gate the corresponding promises. Each counts what actually happened at the
origin, not what the mechanism believes.

| | Question | Pass |
| --- | --- | --- |
| E1 | What bounds live origin transactions and connections? Candidates: permits stored in PostgreSQL, a server-side latest-start fence, a dedicated role with `CONNECTION LIMIT`, a separate Hyperdrive pool. A permit checked before `BEGIN` still leaves a pause window, and a separate Hyperdrive pool is itself a soft limit. | Under admission restarts, executors pausing after admission and starting late, and SQL outliving its client deadline, the origin never holds more background transactions than the budget. Until then the existing `BackgroundAdmission`, which re-grants after a restart or after 30 s, is only valid for short passes. |
| E2 | Does a single statement outside a transaction hold an origin connection only while it executes? | Origin connection time is independent of client round-trip time. |
| E3 | Does a separately deployed executor contain CPU overruns? | A runaway handler does not delay scheduling, the control plane or another kind beyond a stated bound. |
| E4 | The failure matrix below. | Every row passes. |

## Failure acceptance matrix

| | Scenario | Must hold |
| --- | --- | --- |
| A | The writer dies right after committing; no client retries. | The accepted work is still discovered. |
| B | Disconnects at each claim, send, start and finish boundary; duplicated, delayed and reordered dispatch. | Recovery; a token starts once; an old execution never overwrites a newer plan. |
| C | Reschedule, cancel, delete and recreate during an execution. | No old work comes back; uncertain external results keep their reconcile identity. |
| D | An email was sent but the response was lost; the provider has no idempotency key. | The attempt is `uncertain`; nothing claims exactly-once. |
| E | Admission restarts; an old request pauses and begins late; old SQL outlives its client deadline. | The real capacity bound holds, and the document names the origin-side protection it relies on. |
| F | One Space with a million due intents, a small Space's new intent and control operations. | Fair service; bounded in-flight work and dispatch; control steps progress; refusals do not consume business attempts. |
| G | The database slow or down for a long time; a CPU-heavy executor over its limit. | Other resource domains keep serving; diagnostics and backlog are kept; work resumes afterwards. |
| H | A Space moves shards; the partition count changes; consumers on an old release are still running. | No orphaned plan; an old epoch cannot execute or settle. |

## Migration

1. Experiments E1-E3, then the engine with the matrix as its test suite.
2. Gmail notifications first (XMATRIX-HUB-90 and HUB-94): one intent per route,
   with the route's poll and renewal times as the projected wake.
3. Sentry recovery, account and channel deletion, connector cleanups, machine
   load history and the harness release watch, one kind at a time, each with its
   effect contract written down.
4. The minute cron keeps only the driver watch.
