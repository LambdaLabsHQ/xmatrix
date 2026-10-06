# Postgres Authority: Next Environment Plan

The Next environment was retired on 2026-09-25: its branch, GitHub
environment, release workflows, and deploy configuration are removed. This
plan is kept as the design record for the PostgreSQL authority work that
landed on `main`.

Current serving-code retirement is tracked in
[PostgreSQL storage convergence](postgres-storage-convergence.md). Its evidence
and acceptance apply to production; the historical Next receipts below do not
authorize deletion of production namespaces.

Status: accepted implementation direction; M0 accepted on 2026-08-28 and M1
on 2026-08-29. As of 2026-08-31, PostgreSQL is selected as the authority for
Auth, preferences, Space, membership, Channel catalog, messages, Workspaces,
memory, Roles, Agent/App policy, Human Profiles, secrets, billing, content,
runtime, Machine control, Automations, and Trace access in Next. D1 is
absent from the Next Worker binding inventory. The first measured DO retirement
and compaction pass is complete; the M5 rollback observation window closed
successfully on 2026-09-01.

The 2026-08-31 merge-forward integration of current `main` keeps every new
business-fact path on the selected PostgreSQL authorities. Duplicate Channel
display names use a per-Channel storage key so the expand-only PostgreSQL
migration policy does not require dropping the historical unique index; the
same transform is applied by the reusable production fact backfill. Focus
review attempt pointers and exact-Run reads use existing typed PostgreSQL
extension and Runtime facts. GitHub webhook routes are derived from PostgreSQL
connector relations, and trusted App-authored messages commit canonical App
sender snapshots through PostgreSQL message authority. Migration
`0032_expand_main_compatibility` adds the Machine activation transaction table,
allowing signed recovery, epoch fencing, Run adoption evidence, and the
StableGranted claim barrier to remain PostgreSQL-authoritative. Canonical and
legacy ghost stop routes are also persisted or recovered from the issued
Machine command before terminal lifecycle delivery.

The isolated Production PostgreSQL process now uses the separately permitted
host port `10016` in Singapore; Next remains on `10016` on the United States
host. The processes no longer share a physical host; the repeated host port is
intentional. They also use separate containers, volumes, logical databases,
roles, and credentials. A multi-node production availability topology remains
deferred and is not required for this merge-forward integration.

This document is the maintained execution summary.

## Current status

M0 is complete. The final accepted M0 tip was deployed from exact Next SHA
`3fbe1998919c58f3405e9507a739889143dda608`. Resource isolation, PostgreSQL
and Hyperdrive identity, D1 migrations, Hub and Web deployment, DNS, Hub
health, auth behavior, authenticated WebSocket reconnect/catch-up, exact-byte
R2 product read-through, Queue consumer delivery, bounded retries, DLQ
delivery, and live Web build identity passed. The evidence and cleanup results
are recorded in
Next M0 acceptance — 2026-08-28 (record retired with the Next environment).

M1 is complete under the
[M1 execution contract](postgres-authority-m1.md). No product authority moved
during M0 or M1.

M1-A, M1-B, and M1-C are accepted. Hub proves request-scoped PostgreSQL readiness
through the cache-disabled Next Hyperdrive binding, while D1 and Durable
Objects retain all existing product authority. Exact migrations, shard seed,
capacity evidence, and the historical backup/restore exercise passed. By
maintainer direction on 2026-09-07, the host-local PITR, backup, offsite-sync,
and restore-drill implementation was then retired; it is not part of the
current Next operating surface. Historical evidence is recorded in
Next M1-B acceptance — 2026-08-28 (record retired with the Next environment)
and Next M1-C acceptance — 2026-08-29 (record retired with the Next environment).

The bounded product-fact import completed at exact Next revision
`91dc22a803c6a162ed1beda50bc3918dfa21a054`. Release-only migration paths were
then removed and the first retired fact bindings were unbound at exact deployed
revision `0050233854d71b8447b9d6c06ad3de349c91879d`. Hub PostgreSQL readiness,
Auth and preference canaries, Web deployment, exact build identity, and the
core live endpoints passed. Ordinary releases no longer run the one-time
import and the operator route is closed. Failure, recovery, and shard-movement
rehearsals remain later milestones; they are not repeated on every integration
deployment.

By maintainer decision on 2026-08-28, these items are not M0 blockers:

- Next branch force-push and PR/CI protection settings;
- a Next access allowlist (invite-only with Google login disabled is accepted);
  and
- an automatic-backup or migration-evidence baseline, which remains required
  in the later PostgreSQL substrate and production-readiness milestones.

## North star

For every durable product fact, xMatrix has one documented authoritative store:

- PostgreSQL is the authoritative store for business facts and the durable
  transaction/outbox boundary.
- Durable Objects serialize commands, allocate ordered sequence numbers,
  coordinate delivery, and keep only bounded caches and retry state.
- R2 stores immutable blobs and oversized payload bodies; PostgreSQL stores
  their authoritative metadata and references.
- Hyperdrive is the Worker-to-PostgreSQL connection boundary. Correctness
  reads and writes use the uncached binding; explicitly safe projections may
  use the short-lived cached binding.
- D1 remains an isolated authentication authority only while authentication is
  being migrated, then is retired. It never gains new product domains.
- A Space is the logical placement, quota, and migration unit. Shared
  PostgreSQL shards host many Spaces by default; a hot or enterprise Space can
  move to a dedicated shard without changing its stable identity.

The target is not one physical database per Space. The target is one routing
contract per Space over a finite shard fleet. This avoids unbounded Hyperdrive
configurations and connection pools while retaining per-Space mobility.

## Environment and release boundary

`next` is a long-lived architecture integration environment. It does not
replace the release-candidate `test` environment and cannot authorize a
production release.

| Environment | Source | Purpose |
| --- | --- | --- |
| Production | immutable `xmatrix-v*` tag from reviewed `main` | User traffic |
| Test | exact CI-approved `main` SHA | Release candidate validation |
| Next | exact CI-approved `next` SHA | Storage architecture migration |

The standalone Next Wrangler files must name every binding explicitly. They
must not inherit production or Test bindings. Next starts with synthetic data;
copying production data requires a separate privacy-reviewed operation.

## Authority invariants

1. An authority flag selects exactly one writer for a domain.
2. Shadow writes and comparisons are evidence only. A shadow is never a
   fallback authority.
3. A PostgreSQL transaction commits before any message is broadcast.
4. Retry is idempotent. Sequence gaps are allowed; duplicate committed
   sequence numbers are not.
5. A Space placement has one active shard and monotonically increasing
   `placement_epoch`. Stale epochs fail closed.
6. Authority changes preserve counts, ordered digests, behavioral probes,
   recovery evidence, and a bounded rollback or forward-recovery path.
7. Exact-SHA deployment and environment isolation remain release gates.

## Milestones

### M0 — Isolated Next baseline

Status: accepted on 2026-08-28.

- Maintain the protected `next` branch from current `main`.
- Deploy standalone Next Hub and Web Workers, D1, R2, Queue/DLQ, Analytics
  datasets, and independent Durable Object namespaces.
- Provision PostgreSQL shard 0 and fresh/cached Hyperdrive bindings.
- Run the current architecture unchanged so later migrations have a baseline.
- Prove resource isolation, exact-SHA deployment, health, auth preflight, and
  build identity.

M0 does not move authority.

### M1 — PostgreSQL substrate

Status: accepted on 2026-08-29. No product authority moved.

- Rebuild the unused private `@xmatrix/db` prototype from scratch. Its obsolete
  Drizzle/Supabase files are removed; Git history remains the historical record.
- Establish new versioned `control` and `data` schema migrations starting at
  `0000`, with no dependency on or application of the historical `public`
  schema migrations.
- Add an expand/contract migration ledger, bounded query client, timeouts,
  slow-query telemetry, health probes, and storage usage
  accounting.
- Introduce placement and idempotency contracts behind default-off flags.

### M2 — Control facts

Status: complete for the Next integration cutover. Auth and user preferences
are PostgreSQL-authoritative under the
[M2 execution contract](postgres-authority-m2.md). The complete D1 Auth
boundary was copied, fenced, activated, and retired with chained receipts; the
Next Worker has no D1 binding. Space, membership, Channel catalog, and ACL
command and query closures now select PostgreSQL in Next.

- Migrate authentication from D1 through shadow, verification, and explicit
  authority cutover; make D1 read-only before removing its binding.
- Migrate Space, membership, Channel catalog, ACL, and preference facts from
  Durable Objects with the same staged protocol.

### M3 — Message facts

Status: integration cutover complete in Next; fault-injection and recovery
rehearsals remain part of M6.

The write path becomes:

```text
Client -> Channel DO (authorize, sequence, dedupe)
       -> PostgreSQL transaction (message, refs, outbox)
       -> broadcast only after commit
```

Move messages, reactions, annotations, attachment metadata, cursors, and
search metadata. Keep blob bodies in R2. Verify timeouts, post-commit crashes,
duplicates, eviction, reconnect, and concurrent writers.

Message outbox ordering is scoped to the message aggregate: create is entity
version 1, and each mutation uses its committed entity version. Channel timeline
positions remain in the payload and append idempotency receipt, not in the
outbox aggregate sequence. Earlier PostgreSQL append writers mixed these two
sequences, causing a later mutation to collide with the create event. An
authorized mutation now normalizes only that message's exact retained version-1
create event, under the canonical message row lock and in the same transaction.
The correction requires the original event id, Space, Channel, message, payload
entity version and timeline position to agree. It preserves payloads, delivery
status and leases; unrelated conflicts still fail and roll back the entire
mutation. New appends write version 1 directly. No event is dropped or replayed,
and there is no bulk production rewrite.

### M4 — Remaining facts and DO slimming

Status: complete for the Next integration cutover. All configured fact selectors
use PostgreSQL, operation closure is complete, and the first measured physical
retirement and compaction pass has completed. Runtime, Machine, Automation occurrence,
timeout, and Automation management paths are included. Control intents, Space
action claims, and management-action reads now share a transactional
PostgreSQL scheduler repository with bounded authorization, CAS, replay,
outbox, and canonical-intent backfill. Trace request, decision, listing,
single-event authorization, batch authorization, expiry, and Run-lifecycle
invalidation now share one PostgreSQL authority. User Secret catalog metadata,
encrypted values, machine requests, one-shot grants, grant audit, dangerous-action
approval, exact-context claim, and Machine notice creation now share one PostgreSQL
transaction boundary. Slack OAuth session state and encrypted credential handoff,
management snapshot import/read, Focus publication/read, and the exact-Run
management overlay now close against PostgreSQL as one compatibility batch.
Migration `0023_expand_compatibility_authority` adds only the typed, bounded
Slack session table; existing management snapshots and Focus extension records
reuse their previously expanded PostgreSQL tables. The reusable compatibility
smoke exercises all four paths against a real isolated PostgreSQL database and
proves the Slack plaintext is absent from persisted envelopes and replay state.
Live DO rows were not deleted merely because a configured selector uses
PostgreSQL; every physical mutation was separately evidence-gated.

The binding-level reductions remove eleven obsolete per-domain fact namespaces
from the Next Worker: Space root, Space membership, Channel catalog, user
preference, Agent/App policy, scheduler, projection authorization, Trace grant
authority, Trace grant locator, Trace per-user index, and the Secret value authority.
Their classes and Cloudflare migration history remain intact, so existing
SQLite data is preserved and the change is reversible; no new Next request can
address those namespaces. Active logical responsibilities already converge on
the shared scoped-control target, and PostgreSQL adapters intercept the migrated
facts before that target.

The remaining DO bindings are currently classified as directories and routing,
live runtime or device coordination, projections, capacity,
Channel ordering, and the still-oversized scoped-control and Channel-family
compatibility targets. The next reduction must split or suppress
business-table materialization inside those last two targets without removing
their alarms, ordering, delivery retry, or bounded projection state.

The Next Web no longer requires a complete Channel catalog on cold start.
[PostgreSQL Channel catalog pagination](postgres-channel-catalog-pagination.md)
defines the 50-row hierarchical and flat reads, exact Channel hydration,
activity backfill, cross-shard preference routing, and parallel fleet readiness
that prepare this authority boundary for a later Main rollout.

The first schema-slimming cut removes the high-frequency message append dependency
on scoped-control business replicas. PostgreSQL now resolves Human and Agent
attention candidates from current Space membership, Channel ACL, Human handles,
and Agent Profiles inside the message transaction. Exact Agent Run and management
Focus receipts are revalidated in that same transaction; only the Human owner of
an exact active management Run can authorize a selected cross-Channel append.
The Channel coordinator still reserves ordering, while deletion redaction delivery
remains a bounded DO projection responsibility until its PostgreSQL outbox consumer
is activated. Main and Test retain their Durable Object authority paths.

The second schema-slimming cut removes Automation execution reads and writes
from scoped-control business replicas whenever the PostgreSQL selector closure is
active. The occurrence coordinator retains alarms, leases, retry timing, and the
prepared/dispatched fence; Channel, Management config, Agent Profile, Workspace,
Machine, Run, and Instance facts pass through their PostgreSQL product gateways.
Its exact alarm is the earliest of the next enabled cadence, a pending retry, an
expired claim lease, a dispatched Run deadline, a timeout-control retry, or the
two-minute terminal-Run convergence check; retry work cannot sleep until the
next ordinary cadence.
The same cut binds a delete redaction's Space and visibility scope inside the
PostgreSQL message transaction, so the retained projection DO no longer reads its
Channel business replica to classify a PostgreSQL tombstone.

The third schema-slimming cut closes the Free-plan limit notice loop against
PostgreSQL. The message transaction creates the notice fact and returns a durable
wake marker; the selected coordination DO then schedules only the exact alarm.
Shard-filtered PostgreSQL queries claim the notice with `SKIP LOCKED`, advance its
bounded retry lease, append the stable system message through PostgreSQL message
authority, and atomically mark both delivery and billing usage complete. The DO
keeps the alarm and delivery trigger only; it no longer reads or mutates billing
usage or notice business tables when the PostgreSQL selector is active.

The fourth schema-slimming cut removes scheduled dispatch cleanup's final local
`instances` lookup. A PostgreSQL-selected schedule now reads the exact current
Instance from PostgreSQL Runtime authority, verifies that it still belongs to
the leased Run, and performs the terminal offline transition through the same
PostgreSQL repository. Rebound and already-offline Instances remain no-ops;
the legacy SQL collaborator is constructed only for Main/Test's DO selector.

The fifth schema-slimming cut moves the platform-admin overview off the
`space-root` scoped-control replicas. Next reads bounded aggregate and detail
pages from every configured physical PostgreSQL shard, merges duplicate users,
daily activity, and storage categories in the Worker, and reads global Machine
facts once from the directory shard. Main and Test retain their existing DO
overview unless their explicit selector is changed.

The sixth schema-slimming cut removed the Free-limit billing notice. The
allowance is enforced when a message is written: the append statement advances
the counter only below 500, and a rejected write returns `payment_required`
(402) to its sender. Reaching the limit queues no notice, so there is no notice
queue, lease, retry, alarm, or coordinator object. The global notice
coordinator class is deleted by Durable Object migration `v34`. The notice
table and usage columns are dropped from PostgreSQL by a contract migration,
and from the legacy Durable Object schema, once no serving code reads them.

The seventh schema-slimming cut removes PostgreSQL Automation fleet alarms
from every scoped-control object. One global fact-free clock maintains the
finite shard fleet and selects the earliest exact Space and Channel. When work
is due it enters that Space's directory-bound scoped authority through the
ordinary fetch admission boundary; claim, timeout, and orphan convergence SQL
all carry the same Space filter, while message and Agent effects continue to use
their existing typed product gateways. The scoped object performs effects but
stores no Automation fact or alarm. Pre-cutover scoped alarms wake the new
clock before deleting their obsolete schedule component. Main and Test retain
the old coordinator unless explicitly selected.

The clock services an already-due Space before maintenance advances its cadence.
Cadence materialization is restricted to that serviced Space: other due Spaces
retain their PostgreSQL wake even when the alarm reaches its dispatch bound.
Otherwise an unfinished occurrence can coalesce the cadence into the future and
prevent that Space's expired-execution reaping from ever running. A failed scoped dispatch
leaves the due PostgreSQL wake unchanged for retry. After maintenance, the clock
performs at most one additional scoped dispatch for newly materialized work, then
reconciles the next alarm from PostgreSQL. Each dispatch retains the existing
bounded claims and completion fences; neither the clock nor a wake hint supplies
a terminal Run fact.

The eighth schema-slimming cut removes Scheduled message presentation reads
from scoped-control replicas. When a PostgreSQL message append does not carry a
trusted sender snapshot, the message authority resolves the exact Human member
or Agent Profile from the routed Space shard before encoding the immutable
record. Ambiguous retries confirm the digest returned by the authoritative
idempotency result, so a later profile presentation cannot conflict with the
already committed sequence reservation.

The ninth schema-slimming cut suppresses obsolete business-replica ingress in
Next's shared scoped-control objects. Directory identity, redaction projection,
alarm coordination, and exact-Space effect admission remain available; frozen
fact imports, user-Space copies, Workspace hydration, Role copies, legacy
attention evidence, and local business commands now fail closed. Main and Test
retain legacy materialization unless they explicitly select suppression.

The tenth schema-slimming cut applies the same fail-closed boundary to
Channel-family data objects in Next. PostgreSQL message authority and the
per-Channel sequence coordinator serve ordinary traffic; legacy shadow,
baseline, authorization, message, cursor, attachment, capacity, and projection
RPCs cannot read or grow the old family SQLite. If an old family alarm fires,
it deletes the alarm metadata without consuming the retained legacy outbox.

The eleventh cut adds physical retirement for archived, empty Channel-directory
shells. Eligibility is fail-closed: the exact object must have retained archive
evidence in PostgreSQL, zero admitted SQLite rows, no alarm, PostgreSQL message
authority, suppressed Channel-family materialization, and an exact deployed
Next revision. Each deletion is followed by an immutable PostgreSQL receipt;
the operator processes at most 64 objects per request and can resume after a
partial failure. Receipt-backed objects are excluded from later footprint
inventory so measurement cannot recreate their empty SQLite schemas. The first
live run at exact SHA `eaedc4ed5b43a031c8c284c5fc8d80f6b18cb651`
retired all 1,026 shells and recorded 12,607,488 deleted SQLite bytes. The
post-retirement footprint fell from 1,128 objects and 53,268,480 bytes to 102
objects and 40,660,992 bytes while retaining the same 2,392 logical rows.

The twelfth cut applies the same physical discipline to scoped-control history.
It can retire an archived object only when PostgreSQL authority and scoped fact
suppression are active, the exact revision matches the deployed Worker, neither
the immutable retirement manifest nor the active route registry names the
object, its local immutable identity is absent, and its alarm is absent. Routed
or bound objects remain intact. Per-object PostgreSQL receipts keep the process
auditable and stop later footprint collection from recreating retired schemas.
The remaining routed objects will be compacted separately to a minimal
identity, redaction, effect-admission, and bounded coordination schema rather
than being deleted as a class.

The thirteenth cut performs footprint-backed scoped-object compaction. Suppressed
scoped-control objects now start with a coordinator-only schema: routing
identity, projection manifests and redactions, bounded redaction idempotency,
sequence/migration sentinels, usage counters, and a local compaction receipt.
Space membership and Channel authorization for redaction reads come from
PostgreSQL, so the compacted object no longer needs Space, User, Channel,
Runtime, billing, or migration-import replicas. For each routed object, the
operator first records a bounded, content-addressed retained-state snapshot in
`control.durable_object_compactions`, then deallocates its SQLite database and
restores only the coordinator schema. PostgreSQL records completion only after
the restored digest is verified. A matching local receipt makes an ambiguous
retry idempotent without overwriting coordination writes accepted after the
first successful compaction. Revision, Worker version, route membership,
authority selectors, snapshot size, alarm absence, and both evidence digests
are fail-closed gates.

Compaction discovery is deliberately narrower than retirement validation. Its
candidate universe is the union of current active scoped-control routes and
scoped-control objects present in the PostgreSQL fact archive. The immutable
retirement manifest remains a negative deletion fence, not an object-discovery
source: addressing every historical manifest route would instantiate empty DOs
that were never part of the measured live footprint. A dedicated two-phase
receipt can retire only such zero-row, non-active, non-archived compacted shells;
the DO rechecks authority selectors, route absence, identity absence, alarm
absence, bounded SQLite size, and the exact compaction evidence before deletion.

The live cleanup completed at exact Next SHA
`7417bece77a16806bf7a94a04ec713ecf1c0c10d`. It compacted the 24 admitted
scoped-control objects and retired 224 zero-row shells that an earlier
manifest-driven discovery attempt had accidentally instantiated. The final inventory is
102 objects, 9,113,600 physical database bytes, 184,172 logical bytes, and 342
rows. This is an 82.9% physical-byte reduction from the 53,268,480-byte
pre-retirement inventory. The remaining footprint is classified as bounded
directory/routing state, coordinator state, reconstructable Space projection,
and empty Channel-family compatibility shells; no retained object is a selected
business-fact authority.

Future one-shot cleanup must not be coupled to an ordinary product release. The
owning Worker may expose only a small, pre-reviewed, authenticated maintenance
RPC because another Worker cannot directly open its Durable Object SQLite. A
temporary operator Worker should own discovery, batching, evidence, retries, and
the one-shot UI/API surface, then be deleted after acceptance. Do not merge a
Next-only cleanup route into Main merely to reproduce this rehearsal in
production.

Merge-forward work must preserve the aggregate inventory and may retire more
compatibility or migration-only storage only after new evidence. Retained DOs
must stay limited to sequence/epoch, bounded dedupe and retry state, alarms,
directories, and small reconstructable projections. Five percent of the original
DO footprint remains an engineering target, not an acceptance shortcut or a
reason to delete required coordination state.

### M5 — Placement and shard rehearsal

Status: the resumable single-Space movement state machine and operator have
passed both an isolated three-database rehearsal and a live disposable-Space
move in Next. Movement `next-m5-20260831` cut over from `shard-0` epoch 1 to
`shard-1` epoch 2, preserved the pre-cutover message, and accepted a new message
only on `shard-1`. After its 24-hour rollback observation deadline, final
readback preserved the 1-source/2-target message counts and active shard-1
placement and routes. The receipt is `completed`, version 9, with no error; the
source copy remains retained. The operator fix is exact Next SHA
`bbefc9eb364808b540b5aeaf1d83f0c12925d0cc`;
its CI and exact-SHA Next Release passed. This proves the protocol, not
failure-domain or capacity isolation.

Add `control.space_placement` with `space_id`, `shard_id`, `placement_epoch`,
state, target shard, and plan class. Rehearse snapshot, outbox catch-up, digest
verification, DO fence, final catch-up, epoch increment, route flip, and the
read-only rollback window. A second database on the same server tests the
protocol only; a second machine is required to prove capacity isolation.

The initial operator uses bounded, repeatable full-Space reconciliation for
snapshot and catch-up. It copies every classified shard-local table, includes
the durable outbox in the digest, leaves R2 objects in place, and refuses a
Space containing facts whose authorities are not yet fleet-routed. Incremental
outbox application is a later throughput optimization; it is not required for
correctness of the first bounded rehearsal.

The request data path now has a fail-closed finite-fleet router. The primary
correctness binding remains both the placement directory and default shard;
up to four explicitly named additional Hyperdrive bindings can be reviewed into
the Worker. Message, Space/Channel, content, and billing repositories resolve
the current placement before selecting the physical connection, while billing
notice alarms scan each configured physical shard and route exact-Space
completion through the directory. Scheduled occurrence maintenance, claim,
timeout reap, and next-alarm selection also execute per physical shard and keep
each claimed occurrence pinned to its source repository.

Global request routing is a rebuildable control projection, not a copy of
Space facts. `control.channel_space_routes` publishes Channel-to-Space routes
with Channel version and placement-epoch fences; the legacy co-located
directory remains a read fallback during rollout. Likewise,
`control.user_space_membership_routes` publishes membership visibility using
the Space control commit sequence, and Space listing fans the resulting page
into the finite physical shard fleet. A stale publisher cannot overwrite a
newer entity version or placement epoch. The authoritative shard transaction
continues to commit the domain outbox before either global publication, so a
failed synchronous publication is retryable and reconstructable.

Next now provisions the `xmatrix_next_shard_1` logical database and an
uncached Hyperdrive binding for `shard-1`. Both shards use non-superuser runtime
roles, carry the complete migration ledger, and are checked by public
readiness. The global entity directory now routes invite, join request, content,
billing checkout, Runtime, Machine lifecycle, Automation, control-intent,
and management-action requests before their correctness transaction enters a
physical shard. Cross-Space Automation catalogs fan only the caller's
active global membership routes into the finite shard fleet and fail closed
above the reviewed 200-Space bound. The first disposable Next Space move is
complete and retained for its rollback window; its evidence is recorded in
Next M5 acceptance — 2026-08-31 (record retired with the Next environment).

### M6 — Recovery and production integration

Status: complete for the Next integration scope. Current-data PITR, bounded
PostgreSQL/Hyperdrive outage, disk warning/critical alerts, per-shard admission,
aggregate DO footprint, and a prior exact-SHA traffic switch with trap-protected
current restoration all passed. The named restore point, schema and table
inventory, selected authoritative counts, migration ledger, pre/post-point
probe, immutable Worker ids, and recovery timings are recorded in
Next M6 acceptance — 2026-08-31 (record retired with the Next environment).
The offsite path had already passed during M1. This closes Next recovery
integration evidence; it does not authorize Main or production cutover.

- Preserve one-Space shard movement, PostgreSQL/Hyperdrive outage, prior-SHA
  deployment, disk-alert, and admission checks as merge-forward gates. The
  retired host-local PITR implementation is not a merge-forward gate.
- Merge reviewed domains incrementally to `main` behind default-off authority
  flags. Do not merge or cut over the whole Next architecture in one event.

## Rollback rule

Before an authority flip, revert code and continue using the old authority.
After PostgreSQL becomes authoritative, code may roll back while PostgreSQL
remains authoritative. Switching the writer back to a DO requires separately
reviewed reverse-sync proof; the presence of old DO rows is not proof.
