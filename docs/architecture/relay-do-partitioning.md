# Relay Durable Object Partitioning

Status: retired. PostgreSQL authorities replaced the Durable Object control
plane this document planned; its classes remain only as HTTP 410 shells
(`packages/hub/src/retained-fact-namespaces.ts`). The files it names below were
deleted with it. This document is kept as the historical design record.

## Problem

Production originally addressed one `RelayCore/default` object and one
`RelayRuntime/cell-0` object. A sufficiently expensive request or callback
could therefore queue unrelated tenants behind the same Durable Object.

Changing `idFromName("default")` or `idFromName("cell-0")` to a Space or
Channel id is not a safe fix:

- Core is the sole SQLite authority for global, user, Space, Channel, message,
  scheduling, idempotency, and migration facts. Copying that database into one
  object per Space creates multiple owners and loses cross-fact transactions.
- Runtime keeps Human, Agent Instance, Machine Daemon, and Local Replica sockets
  in one object. The adapters currently use in-memory cross-domain calls for
  trace delivery, presence, observable events, daemon-directed trace
  termination, and committed-event fanout.
- A Human runtime attachment can subscribe to Channels in several Spaces. A
  Space-addressed Runtime cannot preserve that single-socket contract without
  an explicit routing layer.

Cold Channel history is not an unbounded Core operation: Core returns an
indexed page of at most 50 rows and the outer Worker hydrates immutable archive
objects from R2. Partitioning work must be based on measured Core/Runtime hot
paths, not on an assumed full-history scan.

Production evidence from August 10-16, 2026 shows why Space isolation alone is
insufficient. `RelayCore/default` handled 3,094,468 requests and produced 662
errors. During both user-visible overload windows, successful HTTP requests
occupied the object for tens to roughly 150 seconds. A separate alarm invocation
on August 12 occupied it for roughly 847.641 seconds. Provider aggregates do not
identify the business operation or Space, so request-level operation, owner,
phase, CPU, and wall-time attribution is an admission requirement rather than an
inference from those aggregates.

## Target ownership

Partition by canonical fact owner, not by request URL.

| Partition | Canonical facts | Must not own |
| --- | --- | --- |
| Global directory | only bounded configuration generations, physical locator versions, and migration/cutover receipts | product reads or writes, user/Space business rows, messages, socket state |
| User authority | user-owned secrets metadata, personal memory/preferences, and user-scoped idempotency; it may itself be fixed-sharded when its owner set requires it | Space membership or Channel ACL |
| Space root/config | Space identity, control-plane generation, and locators for the Space's independently owned control facts | per-message routing, membership rows, Channel payload/history, sockets |
| Membership/access policy | fixed-sharded members, roles, ACL source facts, and cross-Channel revocation workflows | Channel payload/history, per-message fanout, or projection-manifest entitlement state |
| Projection authorization | fixed-sharded per-principal manifest authority, entitlement epochs, and scope-grant reverse index | Channel payload/history, canonical scope heads, or unbounded user/scope scans |
| Channel catalog/tree | Channel metadata, root/thread family relation, create/archive/move workflow, and family locator | message payloads, Channel sequence, sockets |
| Agent/App/policy | Space Agent Profiles, Apps, management policy, and other low-frequency Space definitions | Channel payload/history or per-message routing |
| Scheduler/orchestration | fixed-sharded Space scheduling indexes and orchestration state whose target authority is explicit | message sequence or an unbounded scan of Channels |
| Space capacity authority | one Space's exact text-face usage baseline, prepared/active Channel-family byte-credit reservations, and capacity-command idempotency | ordinary Channel-family append/history, authorization, or rebuildable projection data |
| Cross-Channel projection | rebuildable compact Channel list, unread, mention, Focus, and management read models | canonical Channel payload/history or authorization grants |
| Channel-family data object | one complete data closure for one root Channel and all of its thread subchannels: messages, sequence authority, replies, reactions, annotations, attachment and archive indexes, Channel-bound Runs/Instances, Channel-local schedules, idempotency, and post-commit outbox | Space membership authority, another Channel family, or socket state |
| Runtime connection cell | hibernating sockets and bounded live session state for one deterministic cell | product authority or durable membership |
| Runtime route directory | bounded, expiring mappings from a delivery scope to occupied connection cells | ACL decisions, message payloads, permanent presence |

Every fact has exactly one canonical writer throughout migration. A logical
Space control plane is therefore a group of responsibility-specific objects,
not one physical master object. No ordinary message append, acknowledgement,
history read, or live fanout may synchronously transit Space root/config,
membership, catalog, scheduler, capacity, projection, or global directory. Directory and
Runtime routing projections are replaceable and never authorize a read, write,
or delivery.

`RelayControlPlaneDirectory` is the product-inert physical implementation of
the control-plane route row. One hashed directory object represents one closed
responsibility plus typed global, user, or Space scope. It stores only the
logical-scope digest, opaque server-minted target name, generation, monotonic
route version, phase, and permanent receipt digest. Raw logical ids never
enter target object names; resolving a route never authorizes product access.

## Runtime migration

Runtime moves first because its state is live and rebuildable, but it is not a
string-only routing change.

1. Add a versioned cell locator to server-issued Runtime session tickets. The
   Worker selects the cell after authenticating the principal and registers and
   consumes the ticket in that exact cell. Clients cannot choose an unbounded
   Durable Object name.
2. Introduce a fixed, configuration-versioned cell count. Cell selection uses
   a stable hash of the authenticated owner principal so a Human and the
   owner's Agent/Machine sessions can be co-located where the protocol permits.
   The current product-domain sockets authenticate only after WebSocket
   upgrade, so they stay on the old cell until they gain a server-issued
   preflight ticket carrying the authenticated owner locator. Routing those
   paths from caller headers or an unauthenticated first frame is forbidden.
3. Replace every implicit same-object edge with a typed internal port. Channel
   delivery targets only cells registered for that scope. Principal delivery
   derives the cell directly from the authenticated principal. Presence reads
   query only the cells named by the request's bounded scope; there is no
   all-cell product scan. During dual routing, `cell-0` remains the fixed
   delivery target for product sockets that have not gained the ticket
   contract; directory lookup adds only Relay V2 candidate cells.
4. Route-directory entries are bounded and self-pruning. A connection cell
   registers a scope when its first eligible socket appears and unregisters it
   when the last disappears. A stale entry is removed after an empty/fenced
   delivery response. The initial directory has a fixed 16-shard closed set;
   each entry carries an expiry and is pruned only while register, unregister,
   or lookup traffic already visits that shard. No polling alarm, recurring
   full scan, or request fanout across every directory shard is allowed.
   Directory membership is limited to Relay V2 ticket attachments, whose
   server-issued session expires after at most 15 minutes; the 16-minute
   directory lease therefore cannot expire before an eligible socket. A
   rehydrated Runtime re-registers its unexpired ticket attachments, and
   ordinary Runtime wakes may renew them without creating a timer. Product
   adapter sockets with another lifecycle never enter this projection. An
   empty or fenced response may remove only the lookup's exact observed lease
   expiry, never a later registration.
5. Committed delivery remains best-effort and projection-repairable. Core
   commits exactly once and must not wait synchronously for a fanout across an
   unbounded set of cells. The post-commit dispatcher uses a bounded outbox or
   Queue operation and records no second message authority.

The first rollout is shadow routing: the existing cell remains the only socket
target while the new router computes and audits destinations. Dual live
delivery is permitted only with stable event identities that clients already
deduplicate.
Cutover requires reconnecting old-cell sockets; hibernating sockets are never
silently orphaned. Rollback restores new session issuance to the old cell while
allowing already-issued cell tickets to expire naturally.

## Core migration

Core partitioning is a fact migration, not a deployment toggle.

1. Produce a generated ownership inventory mapping every current table,
   index, query, command, alarm, idempotency family, and post-commit effect to
   exactly one target aggregate. Any unmapped or multiply owned fact blocks the
   migration.
   `packages/hub/src/relay-authority-control-plane-inventory.ts` is the checked-in
   target-responsibility catalog for admitted table owners, product commands,
   product queries, polymorphic domain commands, the Automation alarm, and
   cross-binding effects. Its test compares the catalog with the live schema
   admissions and gateway discriminants, so new behavior cannot silently
   inherit `RelayCore/default`. SQL indexes and method-level effects remain
   part of the generated per-class migration artifact before each cutover.
   `packages/hub/control-plane/relay-authority-current-schema.json` is generated
   from separate blank databases upgraded by the production Core migration
   reducer and each materialized physical-target reducer. Production Durable
   Objects invoke those same target reducers. The artifact records the exact
   SQL text and digest for every table, index, and trigger, groups each source
   object by target responsibility, and records the complete physical-target
   object set plus its SQL dependencies. Generation fails when source
   `sqlite_master` contains an unadmitted table, a target object references a
   relation outside that target, or the responsibility inventory is
   incomplete. Physical targets declare complete or partial coverage. A
   partial target proves only its exact local objects; it cannot remove the
   broader responsibility from the blocker list or claim authority for source
   facts it does not contain. A source-only cross-responsibility trigger
   remains explicit as a compatibility object while RelayAuthority is canonical; it
   is not copied into a physical target and cannot be deleted merely because
   one target is ready.
   The checked-in artifact must match generation. `cutoverReady: false` remains
   mandatory while any physical responsibility lacks equivalent evidence or
   any authority-local primitive placement remains unresolved.
2. Add the responsibility-specific Space control classes and one
   Channel-family Durable Object class. A Channel-family object is named only
   by a server-resolved stable family id; raw caller input never reaches
   `idFromName`. Add schema migrations without changing
   authority. Seed target aggregates through bounded, resumable, digest-bound
   copy sessions. Direct management-plane data mutation is forbidden.
3. Shadow every eligible Core command into the target aggregate from the
   canonical commit's ordered outbox. A target applies only the next expected
   source sequence and stores the source result digest. Shadow failure cannot
   make the target authoritative or alter the canonical response.
4. Verify two complete ordered rounds plus live catch-up: row counts, logical
   bytes, canonical digests, references, idempotency results, alarm ownership,
   and R2 reachability must match for each aggregate. Cross-round drift or an
   unowned row fails closed.
5. Cut over one aggregate class at a time. A root Channel and every thread
   subchannel derived from it select the same object from a stable family root
   id. Channel-family data moves as a complete closure: sequence authority,
   thread-root winner facts, message facts, reactions, annotations,
   attachment/archive indexes, Channel-local schedules and idempotency results,
   and the post-commit outbox. Splitting that closure across writers is
   forbidden.
6. The old Core stores a permanent
   routing receipt and refuses new writes for a moved aggregate. Exact
   idempotent replays remain readable from the retained result until the target
   proves it owns the same command id and result digest.
7. Keep the old database and R2 objects through the reviewed verification and
   PITR window. A cutover receipt grants neither cleanup nor rollback mutation.
   Any rollback before the first target write routes back to Core; after a
   target write, recovery is forward-only.

### Trace-access source fence

Trace access is a fixed Agent-identity-sharded authority. Its target/directory
`authoritative` state means only that an opaque target accepted a verified
shadow receipt; it never by itself changes a product reader or writer. A
prepared target can be stale while RelayAuthority remains canonical.

The final Trace cutover must therefore begin with one durable, permanent Core
source-write fence for the exact shard, committed in the same Core transaction
as a fresh initial shadow route. The source-fence receipt binds the shard, all
route generations, opaque target name, allocation request digest, and fence
time. There is no reset, delete, or reopen operation. The frozen route then
performs bounded copy and two complete verification rounds before target fence,
directory/target activation, locator publication, and user-index delivery
evidence. Only after those facts exist may the product reducers route to the
target.

The current v71 Core record reserves these immutable fence coordinates beside
such a fresh route, but is deliberately product-inert: it has no HTTP or
product caller and does not yet cause Core to refuse writes. A later writer
cutover must consume the exact retained receipt while routing requests,
decisions, all expiry paths, notifications, authorization, listings, and
idempotent replays as one single-writer change. It must not promote an earlier
unfenced shadow or treat a prepared target as a frozen source.

Trace-access runtime messages are post-commit acceleration only. The Core and
the fixed-shard target share the same bounded best-effort delivery helper, so a
future target-owned request, decision, or expiry emits the same event envelope
without calling Core to rewrite a grant. Delivery failure is logged; clients
must still re-read the authoritative grant or index after reconnect.

Space membership and Channel ACL remain authoritative in the Space control
aggregate. A Channel bucket consumes their ordered authorization epochs, but
that projection cannot independently grant access. A membership or ACL
revocation that affects one or more Channel buckets enters an explicit pending
state, fences affected writes, and completes only after the required buckets
have acknowledged the new epoch. It must not report successful revocation while
an old epoch can still authorize a write. Message sequence, content, reactions,
attachments, Channel-local idempotency, and their outbox commit atomically only
inside the Channel bucket.

Agent profiles, roles, App installations, workflow definitions, and Space-wide
Automation policy remain in Space control. Live Agent sessions remain in Runtime
cells. Channel-bound run records, produced messages, and Channel-local schedules
move with the Channel data closure; user-private memory remains in the User
aggregate. No Space alarm may enumerate all Channels. Scheduling is distributed
across Channel data buckets or a separately reviewed fixed-count scheduler
bucket whose commands are idempotent and whose completion is committed by the
owning Channel bucket.

Channel data migration is incremental by complete Channel-family closure. A bounded
copy is followed by ordered shadow catch-up, two digest-verification rounds, a
short write fence, and one permanent routing receipt. The source remains the
only writer until cutover; shadow state never serves authoritative reads. A
persisted verification mismatch may restart only the never-authoritative
shadow generation. Restart first fences Core writes, resets the exact target
shadow under an old-generation/sequence compare-and-swap, advances both sides
to one contiguous generation, refreshes the recursive family membership, and
then repeats the complete baseline and both verification rounds. It cannot run
from a healthy shadow, a verified cutover fence, or an authoritative target;
after success, an identical operator retry is rejected instead of discarding a
new healthy generation. This is forward recovery of disposable shadow state,
not rollback of product authority.

A Channel move between Spaces is a durable workflow with an explicit pending
state, authorization fencing, and forward recovery, not a cross-object SQL
transaction. Stable family-root ids allow the data bucket to remain unchanged
when only Space ownership changes. A thread subchannel must never be
independently hashed or migrated away from its root Channel.

An interrupted authorization refresh remains fenced until ordinary product
traffic completes its recovery. If the local partition-route records have been
retired, recovery resolves the authoritative Channel-family Directory route
and reads the fenced epoch from the Family itself. It verifies the owning Space
and root, rebuilds the bounded authorization snapshot from scoped authority,
and rechecks the route before applying it at that exact epoch. A changed route,
epoch, or failed snapshot leaves access closed; a completed refresh makes a
retry a no-op. Recovery does not recreate retired routing records or modify
message history.

After a family becomes authoritative, append dispatch first asks the owning
Space authority to resolve mention syntax against current Channel visibility.
That resolver reads only stable Human handles from the global directory and
Space-local Agent Profile names, returns stable subject ids, and fails closed
before commit when identity evidence is missing, ambiguous, or over its bound.
The family then derives reply attention from its own canonical message author
and commits the message, attention rows, revisions, and bounded projection
outbox records in one local transaction. Other message mutations do not call
Space or global control objects synchronously. A
family-local alarm drains those records directly into one rebuildable
`RelaySpaceProjection` object for the owning Space, with bounded batches,
idempotent sequence/content-revision guards, and exponential retry. The Worker
does not duplicate that projection write. Out-of-order append delivery may fill an
older projected sequence but cannot replace a newer content revision. Message
edits, recalls, reactions, annotations, attachments, and hard-delete tombstones
advance the projected content revision without re-triggering Focus.

`RelaySpaceProjection` owns only compact Channel-list activity, versioned
per-Human attention summaries/tombstones, a rebuildable post-cutover management
overlay capped at the newest 256 rows per Channel, and a five-minute activity
debounce. Attention revisions prevent delayed mention projection from replacing
a newer clear tombstone; catalog snapshots replace only complete Space slices.
It does
not authorize product access or own message history. One scheduled alarm per
Space coalesces activity and asks Core to accelerate existing Focus Automations; Core
validates the exact Agent Run classifications before suppressing Focus's own
output. Continuous traffic never postpones an already scheduled wake. Its
generated physical-target schema is therefore partial evidence for the broader
cross-Channel projection responsibility: canonical projection forests and
redaction authority still require
separate complete target evidence before that responsibility can leave Core.

Space text-face accounting and family migration receipts are
authoritative invariants, not a rebuildable projection.
`RelaySpaceCapacityAuthority` is therefore a separate per-Space
target behind the opaque control-plane directory. Its physical schema contains
one exact usage baseline, prepared/active family reservations, bounded import
pages, and authority-local idempotency. Merely deploying that empty target does
not move authority: Core remains the sole allocator until every source family
in the Space has applied its migration compatibility receipt, a complete snapshot has been imported and
verified twice, Core allocation is fenced, and the directory's permanent
receipt is published. The target must not receive ordinary append traffic.
Shadow import is ordered and resumable. Each page contains at most 64 grants,
is strictly sorted by family-root id, and is accepted only at the next page
index. The target independently verifies every existing grant receipt, hashes
the canonical page, and extends its stored digest chain in the same transaction
that inserts the grants and advances both import counters. Exact page replay is
idempotent; a changed replay, skipped page, duplicate family, scope mismatch,
or over-count rolls back. Verification recomputes the target snapshot from the
usage baseline, expected grant count, and final chain. Two sequential rounds
must equal the same source-bound digest before any later source fence can be
considered. A target fence then accepts only a digest-bound receipt naming the
verified snapshot, generations, route version, and server-minted opaque target;
every imported family grant must already be active. Activation independently
re-reads the directory and requires its exact permanent authoritative receipt.
Compatibility receipts preserve migration identity and replay evidence only;
they are not a product quota and are not replenished by ordinary growth. No
ordinary append enters the Space capacity object.

Core schema version 66 adds the permanent resumable source controller, and
version 67 adds the durable post-cutover root-registration fence. Begin
first asks the directory for one immutable allocation bound to a request
digest; the caller cannot choose or derive the opaque target name. Core then
atomically rechecks complete root-family closure and exact usage/grant counts
while installing the source route. That route permanently fences the Core
allocator and any later family activation. Scan, copy, and two independently
rescanned verification rounds each persist their own cursor, page index, count,
and digest chain. A page contains at most 64 grants and one request advances at
most 16 pages. Each grant retains its family-local source generation and route
version; those values are not collapsed into the Space controller generation.

After target verification, the target fence accepts one deterministic receipt.
Directory prepare compare-and-swaps that receipt against the exact prior
allocation, Core persists its own fence, and directory publication precedes
target activation. The target independently resolves the directory before it
accepts authority. Cross-object retries are exact-replay idempotent, and every
post-RPC Core stage update must change exactly one compare-and-swap row or
reread the winning durable state. Once authoritative, compatibility-receipt
status comes from the Space target; Core's grant rows remain read-only
compatibility evidence. A post-cutover root Channel is created together with a
durable `direct_creation_fence` in the same Core transaction. Until its own
family has completed the ordinary bounded copy, two verification rounds, and
family fence, Core rejects its append and child-creation paths. The active
Space target then registers exactly one empty fenced family reservation bound
to that family source generation and route version, applies the first local
grant, and only then permits Channel-family directory activation. Retrying the
same create command resumes this forward-only sequence; it never falls back to
the retired Core allocator. This closes only the post-capacity root-admission
boundary, not complete Core control-plane cutover.

User-global operations stay out of a Space aggregate. A command spanning two
canonical aggregates must be redesigned as a durable, versioned workflow with
an explicit pending state and compensating/forward-recovery semantics; it must
not pretend to retain a cross-object SQL transaction.

## Sequence and rank admission requirements

A consumer audit (2026-08-19, channel 47b2304a) established what the split of
the global commit sequence must and must not assume. Per-channel message
`sequence` has **no cross-channel consumer anywhere** — hub, web, desktop,
CLI, and protocol all compare, order, gap-check, and cursor it strictly
within one channelId — so per-channel-family sequence authority is admissible
as-is. The `core_commit_sequence` → `search_rank_seq` axis is not, and any
migration plan must satisfy all of the following before cutover:

1. **Ranks must be unique across every authority that writes into the same
   visibility scope.** A `space:` scope ingests not only every channel's
   messages but also Agent Profiles, Roles, Workspaces, Apps, and management
   work items — after partitioning those come from the Space control plane
   (itself a group of aggregates, not one object) while messages come from
   channel-family buckets, and each authority's counter restarts. Encoding
   only a channel-bucket identity therefore does not close the collision.
   The current encoding has no spare bits — bit 63 namespace, 47-bit commit
   sequence, 16-bit ordinal, exactly 16 hex characters — so embedding
   authority identity is an encoding-contract change that must move in
   lockstep with the protocol documentation and the web, desktop, and CLI
   validators. The web Local Replica uses `searchRankSeq` as its unique
   per-generation document id, and a collision throws on ingest and
   cross-deletes search postings; decoupling that document identity from the
   rank is a sufficient fix for the collision failure mode specifically, but
   it does not satisfy requirement 4 below. Desktop and CLI replicas already
   allocate their own ids.
2. **Same-database uniqueness only dissolves with database-per-authority.**
   The global UNIQUE constraints on `search_rank_seq` and
   `idempotency_keys.commit_seq` are safe exactly because each bucket is its
   own SQLite database; two counters must never share one.
3. **Single-scalar fences become per-authority vectors.** The management
   overlay `changeSeq` (which the CLI fail-closes on across a whole Space's
   mirror) and the ~15 activation/migration fences that equality-check one
   `coreCommitSeq` per Core resource must be reworked to carry one value per
   authority before any authority splits.
4. **Cross-scope "newest first" search ordering is a documented protocol
   contract** consumed by web, desktop, and CLI on one unbounded rank axis.
   Splitting counters makes cross-authority recency arbitrary unless the
   rank embeds a comparable component; the chosen encoding must state what
   cross-authority ordering it does and does not promise, and the protocol
   documentation changes with it. This requirement stands independently of
   requirement 1: decoupling the web replica's document identity resolves
   the uniqueness failure there without restoring any cross-authority
   ordering here.

Reusable as-is: projection scope-head `change_seq` is already per visibility
scope; channel-content revisions already use per-channel monotonic counters;
base/history export ordering survives duplicate ranks through its composite
`(rank, entityKind, entityId)` tiebreak.

### Versioned rank and fence-vector protocol

The pre-split rank format is **v1**: exactly 16 lowercase hexadecimal digits,
containing the global Core commit sequence and transaction ordinal. It remains
valid forever for already-published rows. A future authority must not simply
restart that sequence.

Rank **v2** is the only admissible independently issued format. It is exactly
33 ASCII bytes:

```text
z2_<12 lowercase hex logical milliseconds><14 lowercase hex directory rank authority id><4 lowercase hex ordinal>
```

`z2_` sorts after every v1 hexadecimal rank. Within v2, bytewise ordering is
the documented order: logical millisecond, immutable nonzero 56-bit directory
rank-authority id, then ordinal. A target persists its last logical millisecond
and ordinal in the same transaction as the product write. It uses the current
wall millisecond when it advances; a rollback keeps the last logical value and
increments the ordinal; ordinal overflow advances logical time by one. Thus a
rank has a deterministic, total, cross-authority **recency order**, not a
global serializability or real-time causality proof. The immutable directory
allocation mints each rank-authority id once, outside ordinary product writes,
so two authorities cannot issue the same v2 rank.

The product-inert `RelayRankAuthorityDirectory` is the sole minting registry.
It has one fixed non-product Durable Object name and accepts only a closed
physical responsibility, scope kind, hashed logical scope, already allocated
opaque target name, target generation, route version, and allocation request
digest. In its durable transaction it compares that complete tuple with any
prior row, advances a fixed-width nonzero 56-bit counter exactly once, and
persists the resulting immutable id. A per-logical
`RelayControlPlaneDirectory` may bind the returned id only to its identical
opaque target allocation. The registry never receives a raw product id,
creates a target, publishes a route, activates a target, allocates rank clocks,
or runs on ordinary product reads/writes. The all-zero 56-bit value remains
reserved solely for the legacy singleton entry in a fence vector and can never
be minted or used by a v2 rank.

Current Web, Desktop, CLI, Hub, and projection validation must accept both
grammars before any v2 row is emitted. This compatibility stage only admits
v2; it does not emit it. Old client binaries that understand only v1 must be
version-gated or retired before the first v2 product write. Every existing
string sort remains canonical because the two grammars' byte order is the
protocol order; local document keys retain their entity-identity suffix, so a
storage engine never treats rank alone as document identity.

Every legacy scalar `coreCommitSeq` fence must likewise become a canonical
authority vector before an aggregate splits. A vector is a versioned,
strictly authority-id-sorted, duplicate-free set of nonnegative committed
sequence values. A fence compares the complete expected authority set and all
its values; missing, extra, malformed, or advanced entries fail closed. A
scalar may be adapted only as the one-entry legacy vector while the legacy
Core remains the sole writer. No target route, product RPC, or source fence
may rely on a scalar equality once its responsibility has more than one
writer-capable authority.

An authority target that will later emit v2 ranks begins its bounded shadow
with both the directory-minted issuer id and the canonical source authority
vector. Those values are persisted with the target's immutable source facts,
included in the cutover receipt, and compared again when the target fences.
Activation independently re-reads both the authoritative directory route and
its matching immutable rank binding; a valid route with a missing, changed, or
misbound rank issuer is not activation evidence. Pre-rank shadows remain
inert and must fail closed rather than becoming a shortcut to a v2 writer.

The Agent/App source controller is itself a migration-only, per-Space state
machine. It allocates the opaque target and immutable rank issuer, captures a
legacy singleton authority vector, and scans/copies/verifies at most 64
strictly ordered policy records per page. It may advance only through
`verified`: no source write is yet fenced and no product router consults this
state. A later cutover must separately make every affected command and query
obey the permanent source fence before it can bind a receipt or publish an
authoritative directory route.

Before that later product-routing stage, the Agent/App target may install only
two local writer prerequisites: an exact request-digest idempotency ledger and
its durable v2 search-rank HLC. Both primitives require the target's exact
authoritative identity, and the clock rejects a rank issuer different from the
immutable issuer bound in the directory receipt. They expose no Durable Object
product RPC, do not read or write RelayAuthority business rows, and do not permit a
source fence or directory publication; they are preparation for, not evidence
of, a second writer.

Legacy Agent/App entity identifiers do not all contain their owning Space. The
compatibility locator therefore uses one hash-named object per closed entity
kind and entity id. Its persistent row contains only the entity digest, target
identity coordinates, and final cutover receipt: never the raw id, a business
row, or an authorization fact. A controller may prepare one exact binding and
later activate it with the same receipt; neither coordinate nor receipt can be
replaced. Resolution returns only an authoritative binding, so a prepared
target cannot become an accidental fallback route. This locator resolves a
per-Space target after a caller already has an exact legacy identifier; it does
not enumerate entities, authorize access, or participate in normal writes.

## Admission and capacity

### Final singleton retirement window

The final singleton-authority retirement uses one bounded online maintenance window.
Before reading the migration snapshot, an operator-controlled circuit breaker
rejects the complete product command and query surface with a retryable 503.
That global write/read fence makes the recorded Core coordinate immutable, so
each responsibility can be copied once and verified by exact row count,
canonical logical bytes, and ordered digest instead of maintaining a long-lived
live shadow. The coordinator publishes routes only after every closed inventory
entry resolves to an exact authoritative non-Core target. Publication failure
or any verification drift keeps the breaker armed. Once admission reopens,
`RelayCore/default` is poison-inert and no route, authorization check, operator
action, or error path may fall back to it.

After the immutable retirement manifest covers every closed responsibility and
post-cutover verification succeeds, production deletes the `RelayAuthority` class
with the forward-only `v27` Durable Object migration. The production entrypoint
does not export the class, its Wrangler configuration has no `RELAY_CORE`
binding, and the one-shot retirement operator is removed. Shared internal
reducers may remain behind the scoped successor implementation; nonproduction
historical/recovery fixtures may export `RelayAuthority` only through their separate
entrypoint and configuration. Production keeps the immutable manifest and
directory receipts as audit and routing evidence, but has no singleton fallback
or rollback path that can reopen the deleted authority.

- Fixed counts used by Runtime cells or responsibility-specific control-plane
  shards are reviewed deployment parameters. Channel-family objects grow with
  root Channels by design, but their names come only from the authoritative
  Channel catalog's stable family locator; request input cannot create an
  arbitrary Durable Object.
- Every list, fanout, copy page, verification page, and retry set has explicit
  row, byte, object, and wall-time bounds.
- Channel-family cutover preserves exact Space and family accounting without a
  Space-wide or per-family product byte quota. Core keeps the exact source
  Space counter and one versioned compatibility receipt per family while a
  family keeps an exact transactionally triggered count of live canonical
  message record bytes. Insert and update triggers never compare growth with a
  grant. Safe-integer corruption, negative state, receipt drift, and provider
  physical-storage failure fail closed. The v1 wire/schema fields named
  `grantedRecordLogicalBytes`, `hardBytes`, and `enforced` remain only for
  migration compatibility and mirror exact observed usage (with the positive
  v1 sentinel for an empty family). Core persists a `prepared` receipt before applying its digest-bound receipt
  to the fenced or authoritative target and marks it `active` only after the
  target acknowledges the same version and digest. Activation
  provisions capacity before publishing the authoritative directory route.
  Ordinary family appends, edits, and imports never call Core for capacity and
  cannot be rejected by receipt byte fields. Recall and delete update the exact
  local count in the mutation transaction. Recalled/deleted tombstones are not legacy live records; an
  unrecalled, undeleted message without canonical `record_encoded_bytes` blocks
  grant application fail-closed. Existing authoritative families use the same
  idempotent provisioning endpoint only to establish migration compatibility.
- The per-Space capacity cutover is one-way and Space-atomic. It may start only
  after every live family has applied its compatibility receipt; begin atomically installs
  the permanent Core allocator/root/family fence before source scanning.
  Bounded import pages and two full source rescans precede receipt fencing and
  directory publication. An unavailable capacity authority fails control-plane
  migration operations closed while local product writes retain their ordinary
  path.

`RelaySpaceRootAuthority` is a per-Space dormant physical target for the
complete Space identity, management-config/snapshot, and billing schema
closure. Its deployed class has no product RPC, and the generated artifact
proves only its local SQLite closure. It cannot serve a read or write until a
separately reviewed bounded shadow, two-pass verification, source fence, and
one-way directory receipt establish it as the sole writer.

`RelayGlobalDirectoryAuthority` is the dormant global target for public human
profile facts and handle lookup. Its profile-version field makes a later
ordered shadow import replay-safe, but it has no product RPC or active route.
Only a bounded verified migration, permanent Core source fence, and exact
directory receipt may make it authoritative.

`RelayAgentAppPolicyAuthority` is the per-Space target for Agent Profile
creation and App Connector policy facts. Its artifact-proven local schema has
no Core-global quota trigger. Once its exact source route is authoritative,
the target exposes seven bounded read RPCs for profiles, creation requests,
connections, executions, and source relations. Core continues to perform the
existing Space, Channel, owner, and Agent-run authorization before delegating
the fact read; id-only profile and connection reads must resolve an activated
opaque locator whose receipt matches the authoritative source route. The
target does not accept an untrusted public gateway request directly.
Its migration-only import accepts at most 64 strictly ordered closed-schema
records and 1,000,000 canonical wire bytes per page; a stored page digest,
ordered chain, exact replay receipt, and two equal verification rounds keep
the target strictly shadow-only. Its target-side fence binds only that verified
snapshot to the opaque receipt, and activation independently re-reads the
matching authoritative directory route. Neither target transition publishes a
product route. After a target import page is durably accepted, the Core shadow
controller may prepare only the corresponding digest-addressed compatibility
locators, in bounded groups. Prepared locators remain unreadable and carry no
business data; they are replay-safe migration evidence, not an activation or
route. The Core remains the sole product writer until every catalogued
mutation has a target reducer and post-fence adapter. An absent or prepared
route keeps the legacy read path; an authoritative route never reads the
retained Core copy.

`RelayChannelCatalogAuthority` is the dormant per-Space target for Channel
metadata and tree topology. Its exact local schema contains the `channels`
table and its two catalog indexes. The two old `space_text_face_usage_*`
Channel triggers are deliberately absent because they cross into message and
capacity facts; they remain source-compatibility objects while RelayAuthority is
canonical. This target has no product RPC, route, import, or activation path.

`RelaySchedulerAuthority` is the dormant scoped target for control intents,
dangerous-action requests, management actions, and Space action claims. Its
management-action capacity guard uses a target-local `storage_usage` primitive,
never RelayAuthority's counter. The target has no product RPC, route, copy, fence,
or activation path; a future controller must choose an exact logical scheduler
scope before it can make any of these facts authoritative.

`RelayProjectionAuthorizationAuthority` is the dormant fixed-shard target for
one principal's projection-manifest authority row and complete grant set. The
same shard-local schema also has an active-scope index so a future fixed,
bounded shard set can fan out one scope's reverse-grant read without moving
the per-principal entitlement transition out of one transaction. The target
has no product RPC, route, copy, capacity ledger, fence, or activation path.
Core remains the sole writer until a separately reviewed controller proves the
source transaction, global capacity admission, bounded reverse-read fan-out,
and one-way directory receipt.

`RelaySpaceMembershipAuthority` is the dormant per-Space target for member,
invite, join-request, Channel ACL, and member-creation-policy core facts. Its
local object identity supplies the Space boundary for the legacy
`channel_access` table, which does not repeat `space_id`. This is now its
complete local physical schema closure: `trace_access_grants` belongs to the
separate fixed-shard Trace-access authority rather than this Space-scoped
target. It has no product RPC, route, copy, fence, or activation path;
RelayAuthority remains the sole writer until a separately reviewed migration proves
a one-way source fence.

`RelayTraceAccessAuthority` is a dormant fixed set of sixteen Agent-identity
shards. Each target holds the exact `trace_access_grants` table and all of its
local owner, viewer, scope, expiry, and one-time-instance indexes. A later
controller must select one shard from agent identity, migrate all grant and
expiry transitions under one writer, use a bounded reverse index for owner and
viewer listings, and resolve grant-id-only decisions through an opaque locator.
Product reads must never scan every Trace shard. Its target RPCs are a bounded
64-row, exact-replay shadow import, two stable snapshot-verification rounds,
and receipt-gated target fence/activation. The target persistently binds one
exact twice-verified snapshot receipt and independently rereads the matching
authoritative directory route before activation; it validates the
Agent-identity shard for every copied row. These target-side transitions do
not fence a source or supply a product reader/writer, so this physical closure
does not move Trace authority out of RelayAuthority. The Core controller can now
durably sequence that target fence, directory prepare, Core receipt compare-
and-swap, directory activation, and target activation for one exact receipt.
Every cross-object call is replayable from the persisted phase and receipt.
Only the existing privileged internal migration surface may advance that
orchestration; it has no product route, does not activate per-grant locators,
and deliberately does not claim a source-write fence or product authority
handoff.

On target identity admission, the target atomically records its fixed shard
and requires every later request to agree with it. Once authoritative, its
local alarm expires at most 64 timestamp-due pending or approved grants per
turn, stages the corresponding user-index snapshots in the same transaction,
and schedules the earliest remaining expiry. Its separate 64-row `once`
reducer accepts an exact instance only from a later trusted terminal-event
bridge and reports whether that bridge must retry; the target never infers a
Run or Instance terminal state from a local timer. This local maintenance adds
no product route, source fence, terminal-event caller, or second writer.
The target also permits an exact-grant read only after a future opaque locator
has resolved this shard and then revalidates the grant's Agent shard. That
primitive exposes no authorization decision and is not a product route.
It also has a bounded 1–500-row local grant-scope predicate for a future
trusted Core authorization route. The target checks only approved status,
expiry, permanent/channel/once scope, and a caller-supplied instance-liveness
fact. It cannot authenticate the viewer or decide owner, Channel ACL, or
shared-Space policy, and no public route calls it before those Core facts are
verified. This target primitive neither fences the source nor permits a second
writer.

`RelayTraceAccessLocator` is a separate product-inert compatibility object for
one hashed grant id. It stores no grant row, authorization result, owner,
viewer, or raw identifier: it can only prepare one immutable Trace target
coordinate and resolve it after the exact cutover receipt activates the route.
The Trace controller must prepare it during source copy and activate it only
after its one-way fence; the locator alone cannot publish a product route.

`RelayTraceAccessUserIndex` is a dormant rebuildable user-list projection for
versioned grant snapshots. Its internal apply RPC is version-gated and rejects
same-version drift, but it has no authorization, grant mutation, expiry, or
grant-id routing API. An authoritative Trace shard now has a bounded local
outbox that can deliver owner/viewer snapshots to a digest-addressed index
target. The target's authority-gated create/decision reducer stages it in the
same local transaction, and a separate 64-grant keyset bootstrap can stage one
authoritative target page with replay-safe outbox semantics. Shadow and fenced
targets remain unable to emit cross-object effects. Each reducer call
revalidates the persisted target identity and that the grant's Agent maps to
its fixed shard. The reducer is not registered on any product gateway, so Core
remains the routed writer. A list reader must tolerate replay and lag. The
index preserves the legacy
`requested_at, id` ordering, giving a viewer or owner one target rather than a
scan across Trace shards, while locator-based decisions continue to reach one
authority. The index now persists one target-local user identity before
accepting snapshots and provides a bounded 1–200-row keyset reader. A future
gateway must authenticate the corresponding user before addressing this
digest-keyed object; the reader itself cannot authorize, resolve a grant, or
become a product route. Bootstrap alone never enables that reader: source
writes remain in Core until a later one-way source fence and final projection
delivery proof.

`RelayUserPreferenceAuthority` is the dormant per-user target for a Human's
Space locale and Channel-view preferences. All of one Human's preference rows
remain co-located for the existing `(space_id, user_id)` reads and
compare-and-swap writes. A Space deletion currently removes these rows for
every user and therefore needs a bounded cross-user fan-out before a source
fence can be correct. The artifact labels this target partial and leaves
`user-authority` blocked. It has no product RPC, route, copy, fence, or
activation path; RelayAuthority remains the sole writer.
- Every Core request records bounded-cardinality operation, aggregate class,
  phase, CPU, and wall-time telemetry. Long work is split into resumable,
  cursor-bound steps; a wall-time limit must not abort an ambiguous mutation.
- During Channel-family rollout, `relay_partition_observability_v1` records
  only closed aggregate/operation/phase/outcome dimensions and wall time in
  `xmatrix_relay_authority_observability`; it never records a Space, Channel, user,
  message, or physical object id. Complete native Worker root spans are the
  provider-authored source for Durable Object entrypoint, CPU time, wall time,
  script version, and platform outcome. The two sources are evaluated
  together; application code must not fabricate CPU measurements.
- No product request, alarm, or scheduled trigger may enumerate all Spaces,
  all Channels, all users, or all Runtime cells.
- Product routing therefore has no cross-Space discovery fallback. Run and
  Instance operations carry their Hub-verified Space and Channel coordinates;
  a missing coordinate or Directory route fails before any authority target is
  called. Enumeration remains an explicit authorized catalog operation, never
  a substitute for routing an entity mutation or authentication request.
- An overloaded shard returns a bounded retryable error without exposing the
  provider's raw message. Mutation retries require the existing idempotency
  key and must preserve its exact result.
- An unexpected scoped-authority failure receives an opaque `diagnosticId`.
  The same id is returned in the safe JSON error and
  `x-xmatrix-diagnostic-id` response header and is recorded in native Worker
  logs with a bounded error/cause/stack chain. Raw provider and SQL failure
  details stay server-side; diagnostic logging is observation-only and must
  never become product authority or a required storage write.
- Production acceptance measures Core and Runtime separately under balanced,
  single-hot-Space, single-hot-Channel, and reconnect-storm workloads. The gate
  requires zero overload errors and documented p95/p99 headroom; CI smoke is
  contract evidence only.

## Deployment gates

Each production stage uses the existing exact-successful-Hub-gate SHA and clean
worktree deploy path. A stage must include:

1. static ownership and forbidden-route checks;
2. focused Hub e2e coverage for authentication, cross-Space Human
   subscriptions, Human/Agent/Machine cross-domain delivery, presence,
   reconnect, entitlement add/revoke, idempotent replay, and shard fencing;
3. an isolated real-Cloudflare capacity run against the emitted bundle;
4. a read-only production preflight proving configuration, binding, schema,
   queue, and kill-switch state;
5. post-deploy canary evidence and automatic stop thresholds below overload;
6. an explicit rollback or forward-recovery drill appropriate to whether the
   target aggregate has accepted its first authoritative write.

No dashboard flag, Wrangler variable override, dirty deployment, direct Durable
Object mutation, or unreviewed dual writer can authorize a stage.

The initial few-user canary retains every partition business point
(`RELAY_PARTITION_OBSERVABILITY_SAMPLE_RATE=1`) and complete native root spans.
Before raising that sampling integer, the acceptance artifact must bind a
fixed observation window and report request count, errors, overload outcomes,
p50/p95/p99 wall time, and provider CPU/wall-time maxima separately for
the scoped control authorities, `RelayChannelFamilyData`,
`RelayChannelFamilyDirectory`, `RelayRuntimeLive`, and
`RelayRuntimeRouteDirectory`. Any overload, exceeded
CPU/memory outcome, unexplained server error, or missing class coverage stops
the canary. Sampling changes are reviewed configuration revisions; they are
not runtime or dashboard overrides.
