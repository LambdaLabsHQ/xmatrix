# PostgreSQL storage convergence

PostgreSQL owns durable product facts. Durable Objects retain live connections,
sequence and epoch coordination, alarms, bounded delivery state, and rebuildable
directory or projection state. R2 retains immutable payloads referenced by
PostgreSQL; payload storage is not a second business-fact authority.

This work removes serving implementations incrementally. The historical
[Next plan](postgres-authority-next-plan.md) records migration rehearsals; its
Next-only physical cleanup receipts do not prove production objects are empty.

## First cut: dormant fact namespaces

`RelaySpaceRootAuthority`, `RelayUserPreferenceAuthority`,
`RelaySchedulerAuthority`, and `RelayProjectionAuthorizationAuthority` have no
production binding and no product RPC caller. Their implementations previously
materialized business SQLite schemas on construction and inherited generic
clone import/reset RPCs. They now retain only their historical class names,
return HTTP 410, and ignore historical alarms without accessing storage.
Their business-schema implementations are removed from Worker source.

The pre-removal physical schemas were kept as non-executable JSON in
`packages/hub/control-plane/retained-fact-target-schemas.json` until the
Durable Object control plane retired. That file, its generator and the
control-plane schema artifact were then deleted; the last revision that has
them is `fa34f32f6`. Nothing in the Worker can reopen these namespaces or
apply their schemas.

No SQLite rows, KV values, alarms, PostgreSQL facts, or quarantine evidence are
deleted in this cut. Existing namespace identities and Cloudflare migration
tags remain intact. Recovery is an exact-code rollback while PostgreSQL stays
authoritative; reverting the code does not authorize restoring DO writers.

## Second cut: dormant product and Trace targets

The remaining six unbound namespaces now use the same retained shell:
`RelaySpaceMembershipAuthority`, `RelayChannelCatalogAuthority`,
`RelayAgentAppPolicyAuthority`, `RelayTraceAccessAuthority`,
`RelayTraceAccessLocator`, and `RelayTraceAccessUserIndex`. Their executable
classes are removed, including shadow import, authority activation, product
reads/writes, locator/index RPCs, expiry alarms and notification delivery.
An old Trace alarm therefore cannot expire a second grant copy or emit an
outdated notification after PostgreSQL cutover.

Their low-level migration reducers and schema evidence remain solely for the
historical generator and tests or unresolved legacy scoped-control adapters;
this cut does not claim those compatibility dependencies are gone. The current
Worker exports expose no RPC to invoke them through these namespaces. No data
or migration identity is deleted. Replay/storage-inaccessibility coverage now
applies to all ten retained namespaces.

## Third cut: historical target schemas and unused reducers

The remaining dormant target schema generators are removed from Worker source.
Their pre-removal schema objects and digests extend the same revision-bound
JSON evidence snapshot. The historical artifact remains reproducible without
reopening a Worker schema migrator. Historical migration tests reconstruct
only that frozen final schema through a fixture outside Worker source.

Unused membership/catalog readers, Agent/App target writers, Trace index
reducers and the old notification grant serializer are removed. Tests for
these deleted RPC implementations and obsolete schema-upgrade algorithms are
removed; retained-state/RPC absence tests and surviving migration receipt,
replay, digest, shard and cutover-fence tests remain. This change never applies
a schema to a live namespace or deletes retained facts.

## Fourth cut: suppressed Channel-family RPC admission

Channel-family child registration and all nine inherited clone RPCs now check
the fact-materialization selector before reading or writing durable storage.
This includes schema inspection, import/reset and bookmark restoration; clone
inheritance no longer bypasses the production retirement fence. Repeated calls
fail with the same typed suppression error. Coordination namespaces keep their
existing clone contract through the default admission hook.

The Channel-family implementation remains temporarily because integration
fixtures still exercise its legacy business authority. Those fixtures must
move to PostgreSQL before the implementation can be removed while preserving
coverage of message, attachment and authorization behavior. This admission
change does not delete retained data or authorize a legacy writer.

## Fifth cut: production materialization fences in PostgreSQL fixtures

PostgreSQL lifecycle integration fixtures now suppress scoped-control and
Channel-family legacy fact materialization just as production does. This
exercises product behavior without creating obsolete SQLite schemas alongside
PostgreSQL. Tests may override selectors only when explicitly testing historical
evidence; ordinary PostgreSQL fixtures use the production fences.

## Sixth cut: Channel-family product coverage on PostgreSQL

The Channel-family integration suite now uses isolated PostgreSQL with production
materialization fences. It preserves fresh-Channel placement, message growth,
editing/recall, attachment media, catalog previews, reactions, annotations,
read cursors and membership revocation. The obsolete DO capacity assertions
are replaced by PostgreSQL placement and ordered-growth checks; the current
paged catalog supplies message previews. Reserved annotation namespaces and
non-disclosing authorization failures follow the PostgreSQL product contract.

This migration caught a serving defect: PostgreSQL catalog pages and resolves
reported a constant content revision of zero after message mutations. Both now
read the authoritative content counter in the same catalog statement, so their
revision agrees with history without an additional client round trip.

## Seventh cut: remaining Channel and workspace product fixtures

Channel creation permission, duplicate names, history content revisions,
history paging and workspace registration now use the PostgreSQL fixture.
Their nine product scenarios run with both legacy-materialization fences.

This migration exposed three gaps in the production PostgreSQL path. Ordinary
Channel list/get reads now include the authoritative content counter, just as
the paged catalog does. History applies the existing 4 MiB page byte budget and
reports truncation in either sequence direction; retries resume without gaps or
duplicates. A committed PostgreSQL Space resolves its redaction coordinator
through the existing retirement-manifest router, which may provision a new
empty coordinator but cannot recreate a missing manifest-bound historical
target. Coordinator resolution never falls back to the old fact authority.

## Eighth cut: management, scheduling and attention product coverage

Workspace pagination, platform administration and Human attention
integration tests now use PostgreSQL with production suppression. Mock Human profiles seed account facts
before publishing their projection, matching atomic PostgreSQL mention reads.

The migration exposed two serving gaps. Admin activity now fills the requested
UTC calendar window with zero-count days. Complete Channel catalogs read current
unread attention from the authorized PostgreSQL catalog rather than replacing
it with a dormant DO projection. An unavailable or mixed authority fails the
attention read; it cannot fall back to historical materialization. Mention
notification, replay, concurrent clears, all devices, directory reconciliation,
reply/broadcast/direct attention and private-Channel denial remain exercised.

Permanent-delete product coverage now uses PostgreSQL. Recall and deletion
publish the existing `channel_message_updated` wire message with an empty-body
tombstone to current authorized Human recipients and bound live Agent sessions.
Updates never request an acknowledgement, a task turn, interruption or a native
notification. Web clears the affected history/tail cache and invalidates older
in-flight reads before refreshing; CLI carries the optional `deletedAt` marker
and prints a deletion receipt. Additive marker support requires coordinated
Hub/Web/CLI release; older clients receive no old payload in the update.

Delete retry preflight can read an already-deleted row only after current
Channel and author/admin authorization. The mutation still returns its exact
idempotency receipt before trying a new write; a fresh command cannot mutate a
deleted row. Real PostgreSQL coverage verifies direct and recalled deletion,
private nonmember denial, live notifications, replay and one ledger entry per
mutation. Historical projection redaction coordination and grant-based barriers
remain until their consumers and retained production state are separately
verified; this change never invents a projection grant.

## Ninth cut: the Channel-family namespace becomes retained evidence

The Channel-family SQLite business authority and its schema migrator are removed
from Worker source. The historical class name remains a storage-inert shell with
HTTP 410 and a no-op alarm. It has no product, baseline/shadow import, verification,
activation, clone, recovery or reset RPC. Selector overrides cannot reopen it.
Child-registration and legacy capacity-counter writers are also removed; product
coverage now exercises PostgreSQL placement, growth, permissions and mutations.

The exact pre-removal physical schema joins the revision-bound retained JSON.
The historical artifact remains byte-for-byte reproducible. No retained rows,
KV entries, alarm data or namespace/migration identities are deleted. Existing
PostgreSQL data stays authoritative through exact-code rollback; a rollback is
not permission to select a retired business writer. Remaining legacy scoped
adapters and quarantine/migration ingress are separate cuts; this retained shell
cannot satisfy their old RPCs or silently provide a substitute fact authority.

## Tenth cut: PostgreSQL-only Message dispatch

Append, history, mutations, annotations, acknowledgement, thread-root reads,
sender repair, Human attention and live delivery now use PostgreSQL directly.
The Channel-family router no longer resolves a SQLite business target, retries
legacy authorization recovery, flushes its old outbox, or falls back to its
attention/Focus readers. The old Human-attention retirement API is removed.
Historical Space projection readers and the redaction coordinator stay until
their remaining consumers are independently closed.

The Message selector defaults to PostgreSQL and rejects retired or ambiguous
values before contacting another authority. Existing production already pins
PostgreSQL. This intentional contract change requires PostgreSQL fixtures;
an absent binding is a configuration error, never permission to reopen a DO.
Attachment sealing, current capability checks, bounded recipient delivery,
idempotency and historical redaction barriers retain their existing paths.

## Eleventh cut: PG-only product authority selection

Messages, Channel/Space catalogs, membership, user preferences, billing,
content, workspace facts, shared/assistant memory, Agent/App policy, Human
Profiles, runtime facts, Machine control, Automations and Trace grants default
to PostgreSQL. Explicit retired selectors reject requests before any old writer
or migration journal is opened. User-preference DO shadow admission always
rejects, including with the shadow flag unset.

After the PG adapters decline a product operation, the gateway returns an
unavailable response rather than forwarding it to a manifest-routed SQLite
writer. The two internal Automation coordination commands, historical
projection/redaction coordination and immutable manifest fencing retain their
existing boundary. Their migrations and retained storage are not deleted.

The production config continues to pin the selectors because some feature
activation code still checks those values explicitly. Accounts, Agent Launch
admission and platform Focus migration are separate remaining cuts. Product
coverage exercises empty selectors over real PG HTTP and Human Runtime ports;
historical manifest/coordinator and bounded code-update retry tests remain.

## Twelfth cut: close direct scoped replica ingress

Scoped/Channel-family fact materialization defaults to suppressed and rejects
legacy selection. Scoped cold starts initialize only coordination schema;
legacy product, replica and import RPCs reject before accessing retained facts.
Direct business HTTP requests return 410 while scoped redaction reads and the
two Automation coordination commands keep their existing fences.

Stale scoped alarms delete their obsolete wake instead of invoking business
maintenance. Isolated clone repair retains raw DO replicas rather than pruning
them as live membership authority. Approximately 800 lines of retired replica
hydration, import, admin aggregation and Channel provisioning code are removed.
No namespace, historical migration tag, retained row or physical receipt is
removed. Historical redaction/grant coordination and recovery remain required.

## Scoped projection replay port

Historical redaction replay reads only its projection head and bounded redaction
rows through `DurableObjectStorage`. Runtime barrier delivery requires only the
DO context and environment. Neither path obtains the legacy authority mega-host
or reads Channel/User business replicas. Current PG grant checks remain at the
Space read boundary before the replay reader runs.

Epoch changes, purge floors, future cursors, missing stream evidence, gaps and
oversized records retain their existing fail-closed errors. Paging advances only
a complete contiguous prefix and preserves its byte budget. The old shared
function delegates to this same reader while the inherited base is removed;
there is no second authority or changed grant source.

## Scheduled occurrence dispatch port

Scheduled occurrence dispatch depends only on a typed Focus-review launch port,
its claimed occurrence lifecycle, Run cleanup and message delivery. The shared
legacy entry delegates to that same implementation; the dispatcher itself has
no SQLite access or authority mega-host. It still prepares through the exact
claim lifecycle, cancels removed/disabled Automations, classifies failures and
uses current PG launch authorization through the existing scheduled Agent port.
The scoped object's PG alarm and recovery gate remain to be peeled from the base.

## Thirteenth cut: unreachable host-port declarations

The legacy authority binds its collaborators into one `asHost()` object, so
neither TypeScript nor knip can see which methods still have a caller. A
declaration-level reachability pass from both Worker entries (`src/index.ts`,
`src/index-scoped-authority-test.ts`) and the maintenance scripts that load
Hub source found about 11,700 lines with no runtime caller: recovery and
post-seed evidence builders, legacy retirement imports and exports, Trace and
Agent/App shadow and cutover reducers, Space capacity proofs, attention and
projection writers, archive and closure maintenance, and unused session models.
They are deleted with the tests that only exercised them.

No reachable route, RPC, alarm or fence changed. Retired RPC names that still
have a caller keep rejecting before storage. Retired ingress with no caller is
gone, not kept behind a selector, and tests assert it stays absent. The
retained schema JSON and the control-plane artifact generator are unchanged.

## Fourteenth cut: retired export Queue and completed partition tooling

The `xmatrix-relay-export` Queue and its dead-letter queue recorded no
operations in the 30 days before this cut: its only producers sat inside the
legacy authority, and its consumer reached that authority with no scope, which
the router always answers as unavailable. The Queue bindings, consumer,
producers, cold-history worker and the export, base-export and channel-archive
internal routes are removed. The Cloudflare Queue resources are left in place.

Message append always commits through PostgreSQL, so the HTTP route no longer
keeps the legacy authority fallback, hot-capacity release or projection-capture
retry, and it owns post-commit for every sender. Channel-family, Trace-access
and Agent/App-policy partition admin endpoints and their internal routes are
removed: the scoped authority answers Channel-family partition paths with 410,
and the other targets are storage-inert shells. Global-directory and
Space-capacity partition tooling stays. A Space projection alarm used to retry
retired Focus activity delivery against that 410 forever. It now clears the
pending activity once.

## Remaining cuts and acceptance

1. Remove the remaining historical target-schema/reducer evidence from serving
   source after closing legacy scoped-control adapter and fixture dependencies.
   All ten dormant class implementations are already storage-inert; keep their
   retained storage until physical evidence permits retirement.
2. Remove legacy SQLite fact selectors, reducers, shadow/import and quarantine
   ingress from scoped-control and Channel-family targets. Preserve active
   identity, ordering, projection redaction, delivery retry and alarm behavior.
   Move integration fixtures to PostgreSQL rather than preserving a test-only
   second authority.
3. Retire migration-only Hub routes and SQL migration engines after proving
   no serving or recovery consumer needs them. Preserve immutable retirement
   manifests and receipts that fence retired writers.
4. Physically retire remaining historical state only through bounded,
   idempotent, evidence-gated maintenance with exact revision, selector and
   route checks, retained counts/digests and a verified recovery path. Keep
   discovery and batching in a temporary operator, outside ordinary releases.
5. Provide a single initial DO coordination schema for fresh deployments.
   Preserve the existing production migration tag history: rewriting it would
   change namespace identities or lose prior class deletion fences. PostgreSQL
   remains the only evolving business migration ledger.

Each serving-code cut requires focused fail-closed/replay coverage, Hub
typechecking and the complete CI gate before merge, followed by an immutable
Hub release and post-deploy verification. Physical deletion requires new
production-specific evidence, independently of serving-code removal.

The remaining storage-template and clone recovery integrations no longer
initialize product facts through a retired DO writer. Template isolation uses
Channel sequence reservations; clone export/reset/import/replay and digest
checks use an empty coordination directory. PostgreSQL product integrations
retain Space/profile/catalog behavior. These isolated recovery tests do not
provide production retirement or physical-deletion evidence.

## Scoped projection RPC closure

Scoped-control no longer carries user-preference shadow migration writers or
queries. Their retained RPC names reject before storage. Message-redaction
coordination requires the server's explicit PG Space and visibility scope;
missing bindings fail before looking up any historical Channel row. Direct
Channel partition/focus HTTP routes also return 410 rather than consulting a
retired Channel replica. Redaction coordination state and historical projection
grants remain unchanged; the generic inherited authority must still be removed
in a later cut after its PG Automation and projection collaborators are peeled.
