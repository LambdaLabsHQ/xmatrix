# Entity coordinators

Status: implemented (2026-09-26). Billing: #2913, #2915, #2917 (v0.16.419–0.16.423).
Agent Launch: #2923 (v0.16.425). Automation: #2924 (v0.16.428). The global Agent
Launch, Automation and billing-notice coordinators are deleted (Durable Object
migrations v36, v37, v34).

## Why

Production summons on 2026-09-26 waited 83 s, 7.6 min and 9.2 min between
`prepared` and the spawn command. One global Durable Object,
`postgres-agent-launch-v1-global`, claimed every Channel's Launches and also ran
seven reconciliation passes, some calling other services with no deadline. A new
Launch's wake queued behind the whole round.

The global object is one of three that appeared during the PostgreSQL cutover
(2026-08-27 to 09-05): the Automation coordinator (`f6d82bd8c`, "centralize
postgres schedule alarms"), the Agent Launch coordinator (`589b4169d`) and the
billing-notice coordinator. Each is a "fact-free alarm" that scans PostgreSQL
for work across every Space. Because they store no facts, nothing in the
guardrails or tests stopped them, even though the Relay V2 design gave each
entity its own alarm.

The wrong premise is that **a coordinator finds work by scanning**. Scanning
requires a global scanner, a polling period, and fallbacks for work the scan
has not reached yet. This design removes the premise instead of tuning it.

## Principles

0. **Finish work in the transaction that creates it.** If an effect is a
   PostgreSQL write, it belongs in the originating transaction, not a queue.
1. **Enforce limits where the write happens.** An invariant is checked by the
   write that could break it. It is not detected later and then repaired.
2. **Work that waits on the outside world has exactly one owner entity.** Only
   work that needs an external side effect and its receipt needs a coordinator:
   a daemon command, a retry backoff or a model call. Every such item belongs to
   one Channel, so the coordinator is the Channel's Durable Object.
3. **A request finishes only after its owner has been told.** The request that
   commits work sends one idempotent wake to the owner and waits for its
   acknowledgement before it answers. If that fails, the request fails, and the
   caller's retry (same command id, idempotent commit) sends the wake again.
   Lost wakes therefore need no sweep.
4. **An alarm means "my next item is due", never a heartbeat.** A Channel
   object's alarm is the earliest `next_attempt_at`, lease expiry or retention
   expiry among its own rows. With no work there is no alarm, and there are no
   fixed polling periods.
5. **One mechanism.** Each kind of work implements `due(channel)` (one bounded
   query that returns the next due time) and `run(channel)` (process what is
   due). The Channel object's alarm is the minimum over its kinds. A new kind
   adds these two functions, never a new coordinator.

There is no global work coordinator. The constant-named objects that remain hold
no work: the device-authorization broker, the immutable retirement manifest, the
rank authority directory and the runtime single cell (listed with reasons in
`packages/hub/test/no-global-coordinator.test.mjs`).

## Where each responsibility goes

| Today (global scan) | Disposition |
| --- | --- |
| Billing limit notice queue (`space_billing_notice_deliveries`, one notice per alarm, serial across all Spaces) | **Deleted.** The limit is already an append-time invariant: `message_append_billing_publish_v2` increments `space_billing_usage.free_message_count` only while it is below 500, under the row lock, and otherwise the append fails with 402 `payment_required`, which the author sees at once (principles 0 and 1). The notice message was redundant, so its queue, lease, alarm and coordinator go. The table and columns stop being read and written in one release and are dropped in the next (guardrail 3). |
| Registration revocation discovery (scan all live Runs for withdrawn grant, policy, membership, capability or archive) | **Event.** Each mutation that can withdraw execution authority (registration grant/policy, environment, membership, Channel access, archive, placement) wakes, before it answers, every Channel with a live registration Run in scope (`registration-authority-wake.ts`). That Channel's coordinator re-checks only its own Runs, writes their stop intents and delivers the stops. Continuation already re-checks authority on every turn (`requireRunRegistrationAccess`), so stopping is cleanup and not the security boundary. |
| Registration access-change ledger completion | A change with no unsettled execution completes as it is recorded; otherwise the Channel coordinator completes it once its stop intents settle. |
| Launch claim/publish, reborn advance, stop-command delivery, terminal-report finalization, registration preparation checks and cancellations, routing retries | **Channel object** (`due`/`run` kinds). Each needs a daemon command or model call and its receipt. |
| Settling Launches whose Run ended or vanished; legacy direct dispatch without a Launch row | **Channel object** repair steps for now, scoped to the Channel. Moving them into the transaction that ends the Run (principle 0) is the remaining follow-up. |
| Automation occurrences | **Channel object** kind: `due` is the Channel's earliest enabled `next_run_at`, and `run` materializes the occurrence through the ordinary message path. This matches the original "each Channel-family authority's only alarm is its earliest Automation" contract. |
| Terminal-report retention (7 days) | A Channel kind whose `due` is the oldest finalized report plus 7 days. |

## Triggers

Each write that creates Channel work wakes the Channel object before answering:

- **Message append** with launch control (an `@auto`/runtime summon or a stop
  command) finishes that control before answering, on both the HTTP route and
  the Agent WebSocket append; a launch whose Channel coordinator cannot be told
  fails the append with 503 `agent_launch_handover_unavailable`, and the
  idempotent retry prepares nothing new and tells it again.
- **Launch anyway / retry / reborn request** commit their intent and wake the
  Channel.
- **Daemon terminal report** commits the report and wakes the Channel before
  acknowledging. The daemon retries unacknowledged reports.
- **Authority withdrawal** wakes each Channel with a live registration Run in
  scope before answering.
- **Automation create/edit/pause** wakes its Channel so the alarm follows the new
  `next_run_at`.

A wake carries no payload the object must trust. The object re-reads PostgreSQL,
runs whatever is due and sets its alarm from `due`.

## Concurrency

Channels are independent objects, so load spreads across Cloudflare's placement.
Within one Channel, one `run` pass executes at a time, and wakes that arrive
during a pass merge into the next pass. Rows still use `FOR UPDATE SKIP LOCKED`
with a lease, and daemon commands stay idempotent by control id. An overlapping
pass after an object restart is therefore harmless. Each external call keeps its
own deadline. A slow daemon or model call delays only its own Channel.

Placement spreads CPU, not PostgreSQL connections: every Channel object shares
one shard's Hyperdrive origin pool with user requests. On 2026-09-26, 141
deferred registration stops retried every 10 s, each pass opening transactions
in parallel, and held all 20 origin connections idle in transaction; channel
catalog reads and daemon registration timed out behind them. So:

- **A pass needs a permit.** `RelayPostgresBackgroundAdmission` grants permits
  for one shard, striped: a Channel always asks stripe
  `hash(channelId) mod POSTGRES_BACKGROUND_ADMISSION_STRIPES` (object
  `postgres-background-admission:<shardId>:<stripe>`), and each stripe holds its
  slice of `POSTGRES_BACKGROUND_PASS_LIMIT` (defaults 4 stripes, 8 passes). The
  shard-wide bound is exact and independent of how many users, Spaces or
  Channels hold work; more permit traffic means more stripes, not a higher
  limit. Size the limit as a fraction of the shard's origin pool; more users
  means more shards, each with its own budget. Permits are 30 s leases held in
  memory; the objects hold no work, so they are not coordinators.
- **Summons come first.** A pass after a writer's wake (a summon, a terminal
  report, an authority change) is interactive and may use a stripe's whole
  slice; a pass from the Channel's own alarm (retries, backoff, retention) is
  maintenance and gets half. A refused Channel re-arms its alarm for the
  soonest release plus jitter, without reading PostgreSQL.
- **A pass is serial inside.** Claimed registration stops run one at a time under
  a 15 s budget; one Worker invocation never races its own transactions for
  outbound connections.
- **Work waiting on a host costs nothing.** A stop whose command is delivered
  but not yet run is parked (`last_error_code = 'registration_stop_parked'`,
  next look in an hour). The host's report wakes the Channel, and a woken pass
  also claims its parked stops. Any other deferred stop backs off with its age,
  a tenth of its pending time, from 10 s to 5 minutes.

## Cutover (done)

Each release that deleted a global coordinator was followed by a one-time,
idempotent operator handover that wakes every Channel with open work — due now
or later — paging per shard by `channel_id` cursor:
`POST /api/admin/agent-launch/handover` (31 Channels woken on 2026-09-26) and
`POST /api/admin/automation/handover` (2 Channels). Both require the control
plane operator token or a platform admin. Billing needed none: its queue was
deleted, and its table and columns were dropped by `0095_contract_drop_billing_notice`
after the code stopped using them.

## Guarding against a fourth global coordinator

- `packages/hub/test/no-global-coordinator.test.mjs` fails when a Durable Object
  is addressed by a new constant name; each remaining one is listed with why it
  holds no work.
- `profile-public-interfaces.md` states that coordinated work is owned by the entity it
  belongs to, that the writer tells the owner before answering, and that alarms
  are next-due times, not periods.
- `0096_expand_channel_coordinator_indexes` and
  `0097_expand_automation_channel_index` keep every coordinator read a bounded
  `(channel_id, due)` range scan.

## Follow-ups

- Settle launches whose Run ended inside the transaction that ends the Run.
- Decide whether the runtime single cell and the rank authority directory should
  also be owned per entity.
