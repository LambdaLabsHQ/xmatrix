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
  of the minute. Another deployment will place things differently.
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
- **G3 Scales within stated bounds.** The number of timers, their frequency,
  execution time and external calls grow by adding capacity, without changing
  business code. Every kind and scope has a stated acceptance and capacity
  bound; work beyond it is merged or refused, not silently queued.
- **G4 Slow is normal.** When a dependency is slow, work finishes later. Accepted
  work is not lost, a dispatch token starts at most once, and each attempt's
  duration, the work in flight and the retry rate are bounded. Retries may
  continue until the infrastructure recovers; a finite total number of attempts
  is not promised.
- **G5 Health is progress.** Alerts fire when work falls behind its deadline or
  stops moving, once per incident; defects are still reported. Transient errors
  are telemetry.
- **G6 The platform balances load.** Distributing and scaling execution is
  Cloudflare's job. We keep only what it cannot know: our data's consistency,
  idempotency, and the budgets that protect shared dependencies.

## Three parts

| Part | Decides | Owned by |
| --- | --- | --- |
| Business | What to do and when: timing rules, reschedule, cancel, merge, validity, whether a retry is safe, the lag deadline | Each domain |
| Execution | That accepted work is dispatched, started once per token and settled correctly | The engine, on Cloudflare Queues |
| Resources | How much may touch each shared dependency at once: database phases, external providers, per-scope quotas | The engine's resource entry |

A timer is only one way to trigger work; events and manual triggers use the same
execution protocol. Not every domain has to become a timer.

## Contracts

These hold on any platform.

### Intent

- An intent is identified by `(scope, kind, key)` plus an incarnation that a
  delete and recreate replaces. The scope is `space:<id>` or `system:<kind>` and
  is derived by the server from where the business row lives, never from a
  payload. The intent records its version and, for a Space, the placement epoch.
- An intent is written in the same transaction, on the same shard, as the
  business write. A committed business change with no intent, or the reverse,
  cannot happen.
- Business deadlines (a mailbox's next poll, a watch renewal) stay in the
  business tables. The intent's wake time is a projection the same repository
  method maintains in the same transaction, and each kind can rebuild it.
- An intent carries the plan a running execution consumed and the plan waiting
  to run, the server-side time it may next start (the later of its plan and any
  backoff), and the earliest unmet planned time, from which lag is measured.
  Every business change increments the version:

  | Operation | Pending plan |
  | --- | --- |
  | `set(T)` | becomes `T` |
  | `advance(T)` (no later than `T`) | `least(pending, T)`, or `T` if none |
  | `postpone(T)` (no earlier than `T`) | `greatest(pending, T)` if one exists; otherwise none |
  | `cancel` | cleared; the intent is marked cancelled and stops authorizing further execution |

  A cancelled intent is deleted only after its execution has ended and any
  uncertain outcome is reconciled.

### Execution protocol

PostgreSQL holds the only state; a queue message is a hint that names an intent,
never the authority. Every transition is one statement with server-side lock
and statement limits.

| Step | Effect |
| --- | --- |
| dispatch | A new dispatch token is persisted on the pending intent (in the business transaction itself, or by the step that schedules the next plan) before any message carrying it is sent. |
| start | One compare-and-set from pending to started. It requires the message's incarnation, version and dispatch token to be current; the intent's start time to have passed on the server's clock; the scope's in-flight quota to have room; and, for a Space, its placement to be active on this shard at the recorded epoch. It records the execution token and the execution lease. A duplicated, late or superseded message matches no row and is dropped. |
| finish | Requires the current execution token. If the version is unchanged, the outcome applies. If it changed, the execution settles only its own attempt and receipt: the new plan stands as the business left it, and the old execution's next time is not merged into it. A next plan gets its own dispatch token in the same statement, before its message is sent. |

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
| Committed, message never sent | The intent is pending with an old dispatch; the reconciler sends it. |
| Message lost, expired or out of retries | Same: the intent is still pending in PostgreSQL. |
| Duplicated, late or reordered message | Only the current dispatch token can start, once. |
| Started, then the executor vanished | The execution lease expires; the reconciler applies the kind's contract for an unknown outcome instead of replaying blindly. |
| Finished, next message never sent | Finish persisted the next plan and its dispatch token; the reconciler sends it when due. |
| Finish response lost | If it committed, the work is settled; if not, as for a vanished executor. |

The token fence covers only the engine's receipts and results. Business writes
made by a handler carry their own version or fence checks; an expired execution
can still reach the business tables unless the business checks.

### Side effects

- The engine guarantees at-least-once delivery, one start per dispatch token and
  that an expired execution cannot settle. It does not make external effects
  exactly-once, and it does not infer from an error whether an external request
  took effect.
- Idempotency across retries uses a stable business operation id (a notification
  id, a delivery digest, a control id), never a dispatch or execution token.
- Each kind declares its effects: **safe** (replay is harmless), **reconcile**
  (it can find out whether a previous attempt took effect) or **at-most-once**.
  An unknown outcome is never replayed automatically: a safe kind is dispatched
  again, a reconcile kind runs its reconcile step first, and an at-most-once kind
  is parked for a person.
- Cancel stops further authorization. It does not undo what already happened, and
  a request already sent cannot be recalled by a lease.

### Counting, backoff and lag

- Admission refusals, lost or failed dispatches, business attempts (started) and
  unknown outcomes are counted separately. Only business attempts count toward a
  kind's limit.
- Infrastructure failures (no admission, database unavailable, dispatch lost)
  back off with a cap and keep the intent recoverable. They never park it and
  never exhaust its attempts: a day without a database does not make a periodic
  cleanup disappear.
- Each kind declares its validity (expired work is dropped and recorded), whether
  intents merge, which failures are permanent, an optional business attempt
  limit and its lag deadline.
- Lag is measured from the earliest unmet planned time. Retries and reschedules
  caused by infrastructure do not reset it; only an execution that consumes that
  plan does.

### Resources

- Database phases, each external provider and each scope have separate budgets.
  A handler waiting two minutes on an external API holds no database permit,
  connection or transaction.
- Handlers get no session factory. They call the resource entry
  (`ctx.db.transaction`, `ctx.db.read`, and the equivalents for external
  providers); each call is admitted, opens what it needs, runs one bounded phase
  and releases it. A handler may run many phases across many resources.
  Repositories used by handlers are built on this entry, and a static check
  forbids handler modules from importing a database factory.
- The database budget is per physical database instance, not per logical shard:
  the primary and shard 1 share one origin.
- A per-scope in-flight quota, checked by `start`, limits how much one scope
  occupies execution. It does not make a queue fair, and it gives a small scope
  no bound on how long it waits behind a large one; kinds with different load
  are isolated in separate lanes, and fairness is a measured property (S3), not
  a promise. A large scope's quota row is itself a capacity boundary to measure.
- The engine's own steps (dispatch, start, finish, reconcile) have reserved
  database capacity inside the same physical budget. Reconcile steps are metered
  by what they actually call; being part of recovery does not grant business
  code the reserve.
- When inflow exceeds capacity, work is merged or refused at the entry, and the
  caller can tell reliably accepted work from refused work. Adding consumers is
  not a throughput guarantee.

### What is promised

- Healthy and unsaturated: committed work is dispatched when due and started
  promptly.
- A shared dependency available but saturated: work progresses within the
  capacity left, and lag is visible.
- A whole dependency slow or down (for example the physical database): accepted
  work is kept and retried with controlled backoff, lag is visible, and services
  that do not need that resource keep serving. Quotas are not an availability
  guarantee for work that needs the failed resource.
- Resources are bounded only as far as experiment E1 proves; until then
  admission is a soft limit.
- Never promised: unlimited throughput, exactly-once external effects, strict
  fairness between scopes, or that an expired lease means its SQL has stopped.

## Default on Cloudflare

Load balancing is Cloudflare's. Cloudflare Queues store, distribute and deliver
messages and scale consumer invocations; the default has no partitions, drivers,
executor selection or rebalancing of our own.

1. **Commit.** The business write, its intent and the first dispatch token are
   committed in one transaction on the owning shard.
2. **Send.** After the commit, a message naming the intent (identity,
   incarnation, version, dispatch token) is sent with a delivery delay until its
   wake time. A wake further away than the queue's maximum delay is sent at the
   maximum; on early arrival the consumer persists a new dispatch token and
   sends the next link. PostgreSQL stays the authority, so a lost link is
   recovered once the intent is due.
3. **Execute.** A consumer runs `start`; if the intent is not yet startable
   (backoff, quota) the message is retried with a delay, and a stale message is
   dropped. The handler runs through the resource entry, and `finish` settles
   the result and persists the next plan with its dispatch token before that
   message is sent.
4. **Retry.** Infrastructure failures retry the message with jittered delay and
   never count as business attempts. When a message runs out of retries or
   expires, the intent is still pending and the reconciler sends a fresh one.
5. **Reconcile.** The minute cron triggers one reconciler per physical shard. It
   reads two partial indexes and changes only recovery metadata:
   - pending intents that are startable but whose last dispatch is older than a
     cooldown: each gets a new dispatch token and a message;
   - started intents whose execution lease has expired: each is handled by its
     kind's effect contract (dispatch again, reconcile first, or park).

   Each run is bounded by a row limit, a time limit and its database and send
   budgets. Rows are taken oldest dispatch first, so a row just re-sent moves to
   the back and a large backlog cannot starve later rows; a full page continues
   in the next run. The cron is a trigger period, not a promise that a backlog of
   any size is re-sent within one period. The reconciler chooses no machine and
   runs no business.

Execution lanes are queues: light kinds share one; CPU-heavy kinds, and kinds
that call the same provider, get their own, and CPU-heavy kinds are consumed by
a separately deployed Worker, never beside the control plane or WebSocket
service. One invocation per execution is not by itself proof of isolation: a
Worker isolate can serve several requests at once.

The database entry re-checks admission before each transaction and runs it with
server-side transaction, statement, lock and idle limits. Health is reported as
lag, parked and uncertain counts per kind; external monitoring is a replaceable
receiver, and Sentry Crons is today's choice, not a dependency.

### Platform facts relied on

| Fact | Source |
| --- | --- |
| Delivery is at least once by default; a message can be delivered more than once. | [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) |
| Publish order is not guaranteed. | [How Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/) |
| Consumers scale out with the backlog, up to a per-queue concurrency limit (250). | [Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/), [Limits](https://developers.cloudflare.com/queues/platform/limits/) |
| A queue accepts about 5,000 messages per second; beyond that, sends fail with "Too Many Requests". | [Limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Delivery delay is at most 24 hours; a message is retried at most 100 times; retention is at most 14 days. | [Limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Placement moves only fetch handlers. | [Placement](https://developers.cloudflare.com/workers/configuration/placement/) |
| A Worker isolate can handle many concurrent requests. | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |

### Optional extensions

Each is added only when a measurement shows it is needed:

- more queues for one lane, when a queue's throughput or consumer limit binds;
- per-scope release (sending at most a scope's quota of messages), if S3 shows
  large scopes crowding small ones out of a lane;
- Cloudflare Workflows for kinds that are multi-step processes with long waits,
  after E5. A workflow does not remove the window between the PostgreSQL commit
  and its creation, so the reconciler still applies;
- a Durable Object per entity, where a business needs serialization the intent
  protocol does not give.

### Change to entity coordinators

[Entity coordinators](entity-coordinators.md) say the writer tells the owning
entity before answering, so lost wakes need no sweep, and that no coordinator
finds work by scanning. This design changes that, on purpose: a writer can commit
and die with no one to retry, so the committed intent is the durable record, the
message is a hint, and the reconciler recovers missed dispatch from bounded,
indexed recovery queries per physical shard. It scans no business tables, holds
no work and is not a global serial executor.

## Scale

What grows with users is not what this mechanism costs. A user or entity with
nothing planned has no intent and costs nothing; the engine's cost follows due
work, plus the reconciler's bounded queries.

### Today's ceilings

Each minute cron pass is capped per run, however many machines exist: at most
20 Gmail routes, 2 account deletions, 2 channel purges per shard and 100
cleanups per connector kind. These are our code's limits, not Cloudflare's. A
daily Gmail watch renewal for 100,000 mailboxes alone is about 70 a minute, more
than three times what the Gmail claim admits.

### Load and capacity model

| Symbol | Meaning |
| --- | --- |
| N | Registered users |
| A | Active scopes: Spaces (or system kinds) with at least one intent |
| I | Live intents |
| λ, λ̂ | Due executions per second, average and peak |
| d | Execution wall time |
| o | Origin-connection occupancy per execution |
| e | External calls per execution, per provider |

By Little's law:

- consumer invocations busy ≈ λ·d;
- busy origin connections ≈ λ·o + c, where o is the origin-connection occupancy
  measured per execution: the sum, over its database phases, of how long each
  holds an origin connection. That can include round trips and waits inside a
  transaction and the pool's return delay, which is what E2 measures. c is the
  engine's own occupancy (dispatch, start and finish on the usual path, plus the
  reconciler). Idle pooled connections count separately against the instance
  budget;
- each provider sees λ·e calls per second, and each queue λ (plus retries)
  messages per second.

An example with assumed numbers, not measurements, for N = 1,000,000: a fifth
connect an integration (A = 200,000) with three intents each (I = 600,000), each
due once an hour. Of those, 100,000 fall due in the same minute at the top of
the hour and the other 500,000 spread evenly over the hour (about 140/s). Each
execution takes d = 1 s, mostly an external call, with three database phases.

- Working off the burst within a 5-minute lag deadline needs about 333/s for
  the burst plus the 140/s still arriving: about 475 executions per second for
  those five minutes, so about 475 busy consumer invocations before any
  headroom, which is above one queue's consumer limit. Fewer means the burst
  becomes visible lag, not failures.
- Busy origin connections at 475/s are 475 × o. If each phase held a connection
  only for 5 ms of server time (o = 15 ms), that is about 7. If each phase were
  a transaction spanning a 200 ms round trip (o ≈ 0.6 s), it is about 285, far
  beyond one instance. E2 decides which applies; the example shows why
  database phases must be short and admitted, not what the platform can carry.
- Providers see about 170 calls per second on average. Timing is a business
  decision here: polling every mailbox every minute would be 100,000 calls a
  minute, which a kind replaces by push or a longer interval rather than absorb.

These numbers illustrate the model; they are not capacity, and they do not say
which limit binds first. Provider quotas, physical instances, queue limits, the
quota rows of large scopes, the engine's own statements and the reconciler are
all candidates, and finding the first is what the scale runs are for.

### Recovery cost

- There is no per-user or per-entity heartbeat.
- The reconciler reads two partial indexes per physical shard per cron period.
  When nothing is overdue it costs those reads; under backlog it is bounded by
  its row, time and send budgets, independent of N.

### Fairness

The default gives isolation and quotas, not strict fairness. Lanes keep kinds
with different load apart, and the per-scope in-flight quota stops one scope
from occupying all execution. Within a lane, a large scope's messages can still
sit ahead of a small scope's; how long a small scope waits beside a giant one is
measured in S3, and per-scope release is the extension if it is too long.

### Hot keys

An intent has one valid execution at a time: its version and tokens decide which
result counts. An expired execution can still be running while a newer dispatch
starts another, so the same work can physically overlap; the resource
protections bound that overlap, they do not prevent it. More consumers do not
raise a hot key's throughput, and steps (`continue`) improve deadlines and
recovery but not a serial key's throughput. A hot key's kind must merge wakes,
split into independent sub-work keys that can run in parallel, or refuse at the
entry beyond a stated rate.

### Scaling out on Cloudflare

Edge compute is elastic; the database and providers are not. The design puts
parallelism where the platform has it and bounds only the phases that touch a
shared dependency.

- **Triggering is light; draining is continuous.** Business writes and the
  reconciler send messages; consumers drain the backlog continuously, so
  throughput is not capped by a per-minute batch.
- **These are different boundaries.** `Promise.all` inside one invocation is
  asynchronous concurrency inside that invocation's limits. A service-binding
  fan-out shares the caller's connection limit. Independent queue consumer
  invocations are the platform's horizontal scale-out, and even they may share
  an isolate, so CPU isolation remains E3.
- **The database holds only bounded state phases.** Starting, reading the state
  an execution needs and committing its result are short phases; computation
  and remote waits happen between them, holding nothing. The edge's consumers
  are never all allowed to contend for one pool.
- **Pressure lowers only what it affects.** Free capacity, backlog age and each
  dependency's responses decide how much runs. Pressure on one dependency lowers
  only the concurrency of phases that use it; other work keeps using edge
  capacity. Placement can improve data locality, but correctness never depends
  on a fixed data centre.

### Physical capacity

Logical shards are not capacity: the database budget is per physical instance.
Growth means more physical instances, with Spaces moved by the existing
placement protocol; intents move with their Space's rows under the same epoch
fence, and messages carrying an old epoch cannot start.

### Scale acceptance

No "supports N users" claim, and no claim of linear scaling, before these are
measured in a declared environment against declared lag deadlines:

| | Scenario |
| --- | --- |
| S1 | A million live intents, mostly idle |
| S2 | A large share due in the same minute |
| S3 | A giant tenant beside many small ones |
| S4 | Inflow above capacity for an hour |
| S5 | A slow database: added round-trip time, then several times the server time |
| S6 | Spaces moving between physical shards under load |
| S7 | Consumer concurrency and queues doubled: how throughput and engine cost change, and where the bottleneck moves |
| S8 | One dependency slowed (the database, or one provider): only its phases slow down while other work keeps scaling |

Each run records throughput; lag at p50, p99 and maximum per scope class and
the age of the oldest pending work; engine statements and queue operations per
second; peak origin connections and transactions; and cost per thousand
executions. A run passes only if lag stays within the declared deadline: "it
eventually catches up" is not a pass, and a miss means finding and removing the
bottleneck.

## Experiments

These gate the corresponding promises. Each counts what actually happened at the
origin, not what the mechanism believes.

| | Question | Pass |
| --- | --- | --- |
| E1 | What bounds live origin transactions and connections? Candidates: permits stored in PostgreSQL, a server-side latest-start fence, a dedicated role with `CONNECTION LIMIT`, a separate Hyperdrive pool. A permit checked before `BEGIN` still leaves a pause window, and a separate Hyperdrive pool is itself a soft limit. | Under admission restarts, executors pausing after admission and starting late, and SQL outliving its client deadline, live background origin connections (including idle ones whose transaction has ended) and active background transactions each stay within their own budget. If only one of the two can be shown, only that one is promised. Until then the existing `BackgroundAdmission`, which re-grants after a restart or after 30 s, is only valid for short passes. |
| E2 | How long does a single statement outside a transaction hold an origin connection? | An occupancy model, with and without the client's round trip, that decides whether single-statement steps may serve as resource control or another control is needed. Either finding passes; what the engine must show is that resources stay controlled when the path is slow. |
| E3 | Does a separately deployed executor contain CPU overruns? | A runaway handler does not delay the engine's steps, the reconciler or another lane beyond a stated bound. |
| E4 | The failure matrix below. | Every row passes. |
| E5 | Do Cloudflare Workflows fit multi-step kinds with long waits? | Instance, creation-rate and step limits, cost, and recovery of the commit-to-creation window are known, and the kinds it would serve are named; otherwise it is not adopted. |

## Failure acceptance matrix

| | Scenario | Must hold |
| --- | --- | --- |
| A | The writer dies right after committing; no client retries. | The accepted work is still dispatched. |
| B | Disconnects at each dispatch, send, start and finish boundary; duplicated, delayed, reordered and expired messages. | Recovery; a dispatch token starts once; an old execution never overwrites a newer plan. |
| C | Reschedule, cancel, delete and recreate during an execution. | No old work comes back; uncertain external results keep their reconcile identity. |
| D | An email was sent but the response was lost; the provider has no idempotency key. | The attempt is `uncertain`; nothing claims exactly-once. |
| E | Admission restarts; an old request pauses and begins late; old SQL outlives its client deadline. | The real capacity bound holds, and the document names the origin-side protection it relies on. |
| F | One Space with a million due intents, a small Space's new intent and engine operations. | Bounded in-flight work and queue backlog per scope; engine steps progress; refusals do not consume business attempts; the small Space's wait is measured. |
| G | The database slow or down for a long time; a CPU-heavy executor over its limit. | Other resource domains keep serving; diagnostics and backlog are kept; work resumes afterwards. |
| H | A Space moves shards; consumers on an old release are still running; messages from before the move arrive afterwards. | No orphaned plan; an old epoch cannot start or settle. |

## Migration

1. Experiments E1-E3, then the engine (intent store, dispatch, consumers,
   reconciler, resource entry) with the matrix as its test suite.
2. Gmail notifications first (XMATRIX-HUB-90 and HUB-94): one intent per route,
   with the route's poll and renewal times as the projected wake.
3. Sentry recovery, account and channel deletion, connector cleanups, machine
   load history and the harness release watch, one kind at a time, each with its
   effect contract written down.
4. The minute cron keeps only the reconciler trigger.
