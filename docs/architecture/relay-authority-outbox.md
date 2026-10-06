# Scoped Authority Post-Commit Outbox

Status: proposed. This document defines which post-commit side effects leave
the committing scoped authority's lifecycle and under what contract; it does not
authorize implementation.

Revision 2: addresses the five review findings from PR #1706 — recovery
without borrowing an authority alarm, per-effect originating transactions, generational
effect keys, the About state machine boundary, and a real capacity contract
for a Queue outage.

## Problem

Every committed channel message schedules background work on the committing
scoped authority via `waitUntil`. That work has three structural defects at AI
message rates:

1. **It is lossy.** `waitUntil` is best-effort: an object reset, eviction, or
   platform overload after the commit silently drops the Channel About
   trigger, the mention orchestration, or the projection push. Nothing
   records that the effect was owed.
2. **It feeds load back into the hot object.** The live-fanout retry sleeps
   and re-publishes inside the committing authority's `waitUntil` (bounded to
   overload-only rejections by design — see `relay-authority-live-delivery-retry.ts`),
   and product interpretation re-enters routed authorities with further queries and
   commands from the same lifecycle.
3. **It converts message throughput into orchestration throughput 1:1.**
   Post-commit product interpretation (mentions, About, intervention,
   direct-conversation wake, recurrent eval) runs per message, so the
   amplification factor rides every message rather than being coalesced.

## Inventory (what runs after a commit today)

Each effect names the transaction it originates from. The outbox row for an
effect commits **inside that same transaction** — never in a separate write
that reopens a commit→reset loss window. Live fanout is the one explicit
exception: its row is never pre-written (see the fanout contract below),
because a pre-written row whose direct publish already broadcast cannot be
distinguished from one that never ran, and replaying it would violate the
#1598 no-replay contract.

| Effect | Originating transaction (atomic write point) | Durable today? | Re-enters an authority? | Effect key (with generation) |
| --- | --- | --- | --- | --- |
| Live channel fanout (one Runtime call after #1705) | **exception: no pre-written row** — a repair row is written only after a provably-never-run overload rejection | No | No (targets Runtime) | `(channelId, sequence, messageId)` |
| Committed Human projection push | the domain command that produced the mutations (message append, app/ACL domain commands, …) | No | No | projection mutation set digest |
| Terminal trace purge | the Instance terminal-status transaction | No | No | `(instanceId, terminalAt)` |
| Message redaction projection | the recall/delete/edit command transaction | No | No | `(scopeId, redactionHead)` |
| Hot-capacity release scheduling | message append | No | Yes | `(channelId, triggerSequence)` |
| Product interpretation (`dispatchProductMessagePostCommit`: recurrent eval, Channel About, agent intervention, management mention, direct-conversation wake, agent mentions) | message append (WS path); HTTP-route commits mirror the same rows | No | Yes — heavily | per-interpretation: `channel-about:{channelId}:{sequence/5}`, mention command ids, eval lineage |

Keys that a single scope can emit repeatedly carry a monotonic generation
(`redactionHead`, `triggerSequence`, `terminalAt`): a second, independent
event on the same scope must never be absorbed as a replay of the first. A
re-delivery of the *same* generation is a no-op.

## Design

**Transactional outbox, drained by a Queue consumer outside the scoped authority.**

1. **The outbox row commits with its originating transaction.** Each owed
   effect inserts one `authority_outbox` row — `(effect_kind, effect_key,
   channel_id, sequence, payload, created_at, attempts, leased_until,
   done_at)` — inside the transaction listed in the inventory above. This is
   the durability the current `waitUntil` lacks: once the originating command
   acknowledges, the owed effects are on disk.
2. **A Cloudflare Queue carries the wake-up, not the truth.** After commit,
   the committing authority enqueues a small notification to a new `RELAY_OUTBOX_QUEUE`
   (following the existing `RELAY_EXPORT_QUEUE` pattern). The consumer Worker
   reads owed rows (bounded lease read), executes each effect **in the
   consumer's lifecycle**, and reports completion.
3. **Recovery never touches an authority alarm.** Each Channel-family
   authority's alarm is reserved for that family's Automation cadence
   (`relay-authority-durable-alarm.ts`, guardrails) and gains no outbox work.
   Two recovery paths compose:
   - *Lease recovery:* every consumer wake also claims expired-lease rows —
     covers crashes mid-effect while traffic flows.
   - *Sweep dispatcher:* a cron-triggered Worker (not a DO) periodically
     asks each authority for undone rows older than a threshold. The sweep
     set is **bounded and locatable by construction** through the routed,
     configuration-versioned Channel-family directory — never an unbounded
     object enumeration. This is the guaranteed path for
     the commit→reset-before-enqueue window: the row is durable, the sweep
     provably reaches every authority within one cron period.
     Per the production-schedule guardrail, the cron ships **default-off**
     behind an explicit enable var and its admission gates are launch
     blockers: a declared maximum firing frequency; per-run ceilings on
     authorities visited, rows claimed, payload bytes, DO/Queue calls, and
     wall time; a kill switch checked before any downstream binding is
     touched; cost telemetry per run; and automatic-stop thresholds on
     consecutive failures **and** on cost/operation budgets (per-run and
     rolling: authorities visited, rows claimed, DO/Queue calls, spend) —
     a sweep that exceeds its budget stops itself, not just one that errors.
     Concrete numbers are fixed by the implementation PR from the bucket
     count, but each gate must exist and be tested before enablement.
4. **Consumers are idempotent; the queue is unordered.** Cloudflare Queues
   are at-least-once and unordered. Therefore: sequence allocation and any
   channel-authority write NEVER moves here; every execution is keyed by
   `(effect_kind, effect_key)` including its generation; effects that need
   per-channel order (projection pushes) apply `replace-if-newer` on their
   revision rather than assuming arrival order.
5. **Live fanout stays direct; only its provably-safe retry moves.** The
   first fanout publish remains a direct best-effort call on the commit
   path's `waitUntil` — it is a latency-sensitive hint and a queue hop would
   visibly delay delivery. No row exists while that publish is in flight.
   Only when it fails with the overload rejection — the one failure where
   the platform refused the request *before the Runtime object ran*
   (`relay-authority-live-delivery-retry.ts`) — does the failure handler write a
   repair row for the consumer to replay from outside the hot object. A
   non-overload refusal, a lost response, or a reset during the in-flight
   publish never creates a row and is never replayed: the Runtime broadcasts
   before it responds and the Agent path has no dedupe, so an
   outcome-unknown attempt is unreplayable by the #1598 contract. The
   failure-handler write can itself be lost to a reset — that loss surface
   is exactly today's, so v1 migrates the safe retry out of the hot object
   and deliberately does **not** upgrade live-fanout durability. The named
   prerequisite for any future at-least-once upgrade is receiver-side
   messageId dedupe at the Agent instance path (duplicate deliveries were
   observed live on 2026-08-17); that is separate work, out of this ADR's
   scope.
   The repair row's consumption is **at-most-once: terminal before publish.**
   The consumer durably marks the claimed row terminal (`attempted`) and only
   then makes its single publish attempt. A crash between the mark and the
   publish loses that repair opportunity — again today's exact loss surface —
   while lease recovery only ever sees a terminal row and can never
   re-broadcast. An at-least-once consumer cannot be made exactly-once
   without receiver dedupe, so the ambiguity always falls toward "lost", never
   toward "duplicated", the same principle as #1598.
   Two implementation contracts follow and are review requirements, not
   suggestions: `attempted` is a first-class terminal state that the sweep
   dispatcher and lease recovery skip — the generic expired-lease claim in
   the recovery path must never cover fanout rows; and an overload rejection
   *after* the terminal mark does not re-arm the row — strictly narrower than
   today's three in-object attempts, which is exactly the "v1 does not
   upgrade delivery reliability" posture.
6. **The About state machine's merge boundary does not move.** Today the
   first trigger acquires and starts the summary session; only while a
   session is active do later triggers merge into one latest pending
   successor (`relay-authority-domain-command-resources.ts`,
   `channel-about-session.ts`). The outbox changes the *durability and
   execution home* of triggers, not this state machine: every every-5th
   trigger writes its row; the consumer feeds triggers to the same
   first-active + one-latest-successor logic. Backlog compaction applies
   only where that machine already merges (the pending-successor slot),
   never before a channel's first owed execution.
7. **Poison rows dead-letter.** `attempts` past a fixed budget parks the row
   (`done_at` set, `outcome = dead`) and emits an observability point; a
   parked row is diagnosable state, not a silent loss.

## Capacity contract (Queue outage)

`attempts` budgets bound retries, not growth: during a full Queue outage no
consumption happens while commits keep writing rows. The contract:

- **Hard bounds** on pending outbox state per authority: row count and total
  payload bytes, sized so the outbox can never crowd the authority's own
  product storage.
- **Safe compaction first:** kinds whose own semantics already merge
  (About pending-successor, hot-capacity latest-trigger, projection
  replace-if-newer) compact under pressure without semantic loss.
- **Explicit degradation at the bound:** a non-compactable effect that
  cannot get a row executes on the legacy in-object `waitUntil` path —
  exactly today's behavior, so the system under a Queue outage is never
  worse than the system before this design. That degraded execution leaves
  **no outbox row**, emits a dedicated telemetry point (kind, authority,
  pressure level), and must never block or roll back the already-committed
  authoritative transaction it rides on.
- **Retention never deletes an undone row** below the hard bound; owed-effect
  durability is the point of the design.

## What stays synchronous (unchanged)

Sequence assignment, ACL check, message persistence, idempotency result — one
authoritative transaction in the Channel-family authority, plus the outbox inserts that
ride their originating transactions. Nothing else.

## What this does not change

- Product semantics: About cadence and its first-active/one-successor state
  machine, mention grammar, wake behavior, Focus triggers — all fire on the
  same conditions; only the execution home and durability change.
- The Runtime ACK batch path (#1705) and projection `replace-if-newer`
  contracts.
- The partitioning ADR (`relay-do-partitioning.md`): the outbox is the
  "post-commit outbox" that document already requires per channel-family
  bucket; landing it before partitioning shrinks the migration closure, and
  the sweep dispatcher's bucket registry is the same fixed set that ADR
  defines.

## Rollout

1. **Shadow:** write outbox rows alongside today's `waitUntil` execution;
   consumer only records lag metrics. Proves row volume and drain latency.
2. **Cutover per effect kind**, lowest risk first: trace purge → redaction
   projection → product interpretation → projection push → fanout repair.
   Each kind flips behind its own flag; rollback is flipping back (legacy
   `waitUntil` code stays until the kind is stable — it is also the
   degradation target above, so it is not dead code).
3. **Cleanup:** the outbox tables join the channel-family closure inventory
   for the partitioning migration.

## Verification plan (per contract)

- **Atomicity:** for each inventory class *except live fanout*, a test that
  fails the process between originating commit and any later write and
  proves the row exists iff the commit does. For fanout the inverse is the
  contract: no row exists after a successful or outcome-unknown direct
  publish; a row exists only after an overload rejection.
- **Recovery:** a test that drops the queue notification entirely and proves
  the sweep dispatcher drains the row within one period; a lease-expiry test
  for mid-effect crashes.
- **Fanout no-replay:** a reset injected during an in-flight direct publish
  produces no row and no replay; a consumer crash injected between the
  terminal mark and the repair publish loses the repair without a duplicate;
  lease recovery over a terminal repair row never publishes.
- **Cron admission gates:** each gate above (frequency ceiling, per-run
  ceilings, kill switch, cost telemetry, auto-stop) has a test proving the
  cron refuses to run past it; these are enablement blockers, not
  follow-ups.
- **Generations:** same-scope successive redactions/purges execute both
  generations; re-delivery of one generation is a no-op.
- **About boundary:** consumer-driven triggers reproduce the existing
  first-active + one-latest-successor transcript against the current state
  machine's tests.
- **Capacity:** at the hard bound, compactable kinds compact, non-compactable
  kinds run legacy-path with telemetry and no row, and the authoritative
  commit is unaffected.
- **Runtime behavior gaps flagged in the #1705 review** (flushAcks per-item
  rebuffer on malformed/partial responses; combined-route empty/non-empty
  human branches) land with the first implementation PR that touches those
  files.

## Observability

Each effect kind is an Analytics Engine operation under the scoped-authority
dataset conventions: enqueue count, drain latency, attempts,
dead-letters, degraded-path executions. The overload question this answers:
how much of today's authority occupancy is post-commit work that no longer needs
to live there.

## Failure modes considered

- **Queue outage:** rows accumulate up to the hard bounds; compaction and
  the explicit degradation contract above bound growth; the sweep drains the
  backlog on recovery.
- **Consumer crash mid-effect:** lease expires, row re-drains, generational
  idempotency key absorbs the replay — except fanout repair, whose
  terminal-before-publish consumption means a crash costs the repair rather
  than risking a duplicate.
- **Double execution:** every effect is keyed with its generation; the
  inventory shows each key exists already — no new global identifiers.
- **Authority reset between commit and enqueue:** for the five pre-written
  classes the row is already durable in the originating transaction; the
  sweep dispatcher finds it without the queue hint. Live fanout is exempt by
  design: a reset around its direct publish loses at most the repair
  opportunity — today's exact loss surface — and never causes a replay.
