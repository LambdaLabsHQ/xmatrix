# DingTalk cross-database effect coordination

Status: inactive implementation, reviewed against repository source and official
documentation on 2026-10-05 UTC. The coordinator, narrow prepared driver, independent journal/gate/receipt
schema and actual-owner adapter are implemented; no production path or native
capability issuer, recovery wake or cross-shard delivery is enabled.
[The existing inbox](dingtalk-business-inbox.md) and v785 actual owners continue
to reject a physical shard mismatch. Real company mode and conversation proof
remain independent native prerequisites.

## Guarantee and prerequisite

The proposed guarantee is retirement-completion ordering: a source retirement,
grant rotation or target permission revocation that commits first prevents the
effect; an effect irrevocably decided while both authorities are locked must
become visible before its source retirement can commit. This is not simultaneous
visibility across databases or cancellation of an already decided commit.

Ordinary RPC admission and holding a primary connection during a target RPC do
not provide this guarantee. Connection loss releases ordinary primary locks
while a target COMMIT can remain in flight. The ordinary `packages/db/src/client.ts` path owns one physical
BEGIN/callback/COMMIT and commit-unknown handling. The narrow prepared driver
does not itself own a distributed decision; that belongs to the primary journal.

The candidate protocol uses PostgreSQL two-phase commit on both participants.
[PREPARE TRANSACTION](https://www.postgresql.org/docs/17/sql-prepare-transaction.html)
persists transaction state independently of its session and retains its locks.
Resolution can use another session. PostgreSQL's
[lock implementation](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/storage/lmgr/lock.c)
excludes session locks from prepared state; mixed session/transaction locks on
the same object can prevent preparation. The actual company advisory **transaction**
lock and all required row/lifecycle locks need physical prepare/restart tests.

[max_prepared_transactions](https://www.postgresql.org/docs/17/runtime-config-resource.html#GUC-MAX-PREPARED-TRANSACTIONS)
defaults to zero and is a server-start setting. The production origin
(PlanetScale Postgres since 2026-10-06) reports `max_prepared_transactions = 0`,
so this protocol cannot run there until the provider allows a non-zero value. Hyperdrive documents
[transaction pooling and named prepared statements](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/);
that is not evidence that SQL PREPARE TRANSACTION is supported on our path.
The [supported-feature reference](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)
(last updated 2026-09-30, checked 2026-10-05 UTC) explicitly excludes advisory
locks, SQL prepared-statement management, LISTEN/NOTIFY and undocumented session
state. Its PREPARE wording does not establish support for PREPARE TRANSACTION.
Our current company writers use advisory transaction locks. Direct private PG
success therefore cannot attest production serialization or two-phase commit.
Typed admission defaults to unknown/denied and requires evidence for the exact
selected connection path, database identity, role, two-phase operations, retained
serialization and independently waking recovery. A row-lock replacement would
need one coordinated change across every init/accept/rotate/retire/drain writer,
including races before a company row exists; changing just this coordinator is
insufficient.

No direct-connection fallback, new credentials, settings change or migration
privilege is authorized by this design. Missing capability evidence keeps
cross-database effects disabled.

## Owners and binding

| Fact | Sole owner | Required boundary |
| --- | --- | --- |
| Company/native grant, inbound generation, encrypted scope, job and original Human identity | Primary DingTalk repositories | Source participant derives facts from the current locked records; no caller-supplied identity or copied grant |
| Effect decision and recovery epoch | Proposed primary `DingTalkEffectCoordinator` | Durable conditional transition; independent of participant locks |
| Current Space members, Channel ACL/lifecycle, source relation, Automation owner/enabled/triggers and placement | Actual target physical owners | Member-before-Channel locks, fresh statements after waits, current relation/Automation checks |
| Message/trigger, canonical payload and stable replay result | Actual Message/Automation owner | Same target prepared transaction as target authorization and effect receipt |
| Prepared transaction and local attempt gate | Narrow participant transaction manager | Exact database/role/GID namespace and coordinator binding; no arbitrary SQL/GID input |

One coordination is for one existing stable effect ID, not a whole fanout. Its
immutable binding includes app identity, connection birth/ID, company digest,
parent/inbound generations, event/content/scope digests, original Human, job/lease,
effect kind, destination kind/ID, Space and both physical database identities.
Target birth/version/root/owner and placement epoch are independently checked;
they cannot silently change on a retry. The original Human and target creator,
authority root and Automation owner retain separate current permissions.

Source votes are narrow references resolved by trusted owners from durable
coordination and participant records. A GID appearing in `pg_prepared_xacts`
alone is not a content or permission proof. A JSON command field, projected
member role, signed client assertion or previous `current=true` cannot create a
vote or a capability. Private content stays within the established encrypted
inbox and canonical message boundary; coordinator records retain only scoped
references/digests and terminal evidence.

Existing inbound attempts/scopes and App connections block Space movement.
Cross-shard routing cannot lift those blockers or consult stale primary copies
of moved Space membership. A later migration contract must place Space facts at
their actual owner and split current source grant checks from target Space checks.
The target participant checks the original Human's current membership against
the consent binding, as well as all independent target Humans. Candidate discovery
must use the actual placement; labels never authorize a destination.

## State and transaction sequence

The primary journal has immutable binding and monotonic states:
`preparing -> commit_decided -> committed` or
`preparing -> abort_decided -> aborted`. Recovery-required is an operational
condition on a nonterminal state, not permission to reverse its decision.
An attempt epoch fences preparation; leader epochs fence journal mutation.
Decision rows are never locked by a prepared participant: otherwise the manager
could deadlock against the locks it must resolve.
Journal/gate outcome evidence must not have cascading deletion from grants,
connections or payload jobs. Retirement and private cleanup cannot erase the
decision needed to release their own blocked participants. Lifecycle deletion
must reconcile nonterminal coordinations before reporting completion.
Journal isolation also excludes foreign-key validation, unique/exclusion keys,
index conflicts and triggers that can wait on prepared source pin/job writes.
Test a decision and a leader takeover while the full source transaction is
prepared; a separate table or row alone does not prove this independence.

1. The coordinator reserves the complete binding, deterministic participant GIDs
   and bounded capacity in a primary transaction. Each participant commits a
   matching local attempt gate before opening its participant transaction. GIDs
   use a reserved namespace plus a full digest and attempt epoch, below PG's
   200-byte limit; no private fields or truncation aliases are embedded.
2. The source owner takes its local attempt gate, then existing company-before-
   source-row locks. It rechecks native grant, scope, original identity, job lease,
   content and generation. It writes a per-effect source receipt/job pin and
   PREPAREs. It does not prepare while holding the coordinator journal row.
3. Only after source preparation is confirmed, the target owner opens its
   transaction under its local gate and exact placement. It resolves the reserved
   source vote through the trusted coordination boundary, locks each current
   member (zero rows deny), then Channel and relation or Automation in existing
   writer order. New statements re-read role/ACL, target version/birth/features,
   owner/root/enabled/triggers. It writes the actual canonical message or trigger,
   stable replay and participant receipt, then PREPAREs. All authorization locks
   survive worker exit. No external provider call occurs in this transaction.
4. With both exact preparations confirmed and their bindings verified, the
   coordinator conditionally commits `commit_decided` on the primary. Primary
   database time must precede the minimum lease, payload, proof and attempt
   deadline. Abort wins instead if cancellation or failed preparation reaches
   this conditional transition first. No fallback COMMIT is sent when the
   decision is unavailable or unknown.
5. The durable COMMIT decision is the irreversible global linearization point.
   Resolve the **target first** with COMMIT PREPARED and verify its exact owner
   receipt. Keep the source prepared until that result is proved. Then resolve
   source, verify its receipt and mark the journal committed. Source retirement
   stays blocked until target visibility is established; releasing source first
   would allow retirement to finish before a delayed target commit and is invalid.
6. An ABORT decision resolves both participants with ROLLBACK PREPARED, closes
   both attempt gates, proves no executing/prepared participant remains and then
   marks aborted. Per-effect pins release only after this terminal proof. Fanout
   progress uses the same stable effect IDs; one committed target is never undone
   or reinterpreted as an entirely unprocessed event.

The lease/deadline gates the durable decision, not a future recovery RPC. After
COMMIT is decided, expiry, cancellation, drain timeout or later native unavailability
cannot turn it into ABORT. Recovery may physically finish later, with source
retirement still blocked. This is an explicit proposed extension of the current
single-transaction in-flight COMMIT semantics, not a claim that every physical
write can be cancelled at an absolute wall-clock deadline.

The coordinator imposes bounded admission and RPC budgets and per-company/app
prepared-work capacity. Recovery sweeps have bounded batches and exact namespaces.
A partition can keep undecided/decided preparations blocking retirement beyond a
request deadline: strict safety cannot promise bounded completion during loss of
the decision authority. Alert and freeze new admissions; never release locks by
guessing ABORT or declaring retirement complete. Prepared transactions must be
resolved promptly; their persistent locks and vacuum impact are operational costs.

## Unknown results, delayed workers and recovery

| Lost response/crash | Required evidence and action |
| --- | --- |
| PREPARE acknowledgement lost | Resolve the exact reserved participant using its local attempt gate, actual database/role and prepared inventory. Absence is not yet terminal if an old session can still PREPARE. Never create a different effect ID. |
| Coordinator decision COMMIT acknowledgement lost | Read the primary journal through the authoritative uncached owner. A conditional ABORT must serialize on the same journal row; it cannot overwrite a concurrent COMMIT decision. If unavailable, retain preparations and report recovery-required. |
| Target COMMIT PREPARED acknowledgement lost | Query exact committed target receipt/replay under the immutable binding. If still prepared, repeat the recorded COMMIT. If neither prepared nor receipt exists, quarantine; do not release source or infer rollback. |
| Source COMMIT PREPARED acknowledgement lost | Resolve its exact source receipt/prepared state from the durable COMMIT decision; never reread a later retired grant as grounds to abandon an already decided effect. |
| ROLLBACK PREPARED acknowledgement lost | Follow only recorded ABORT; prove local gate closure and participant absence before terminal cleanup. |
| Worker/leader lease lost | New journal updates require the new leader epoch. Old workers may only report results or perform idempotent resolution of the same immutable durable decision; they cannot decide or open a new attempt. |

Local gate closure is part of recovery, not a TTL delete. A participant takes its
matching gate lock before preparation and holds that lock through PREPARE. After
ABORT, recovery serializes closure against any executing or prepared participant,
rolling back exact prepared GIDs while a closure waiter is blocked. Only after the
closure lock is acquired, its state is durably closed and no execution/preparation
remains can absence certify abort. Otherwise an old worker could PREPARE just
after an inventory scan and leave an orphan despite a terminal journal.

Participant inventory, local receipts, journal bindings and exact role/database
must agree. Unknown foreign GIDs and conflicting receipts are quarantined, never
bulk-rolled back or adopted. Database restore/failover identity changes require
reconciliation before admission; restoring the decision journal to an older point
can lose an irreversible decision and must not silently resume. Decision records,
closed gates and outcome tombstones outlive all retries, prepared transactions and
backup recovery windows; private payload may be erased without erasing decisions.

Commit confirmation uses a separate internal receipt reader, restricted to the
durable decision, exact target binding and digest/outcome. A permission revocation
after the target committed must not prevent proving that earlier commit and thus
strand the source lock. This reader cannot expose message content, append again,
fire again or return a public replay result. New effect admission and public replay
still require current grants; resolution of an immutable decided transaction is
a different capability, not a widening of those grants.

Global acquisition order is coordinator reservation (released), source company
and source rows, then target members/Channel/relation/Automation. No target holder
may open a new source lock transaction. Recovery decisions touch independent
journal rows; participant resolution acquires no product permissions anew. Separate
servers cannot detect a distributed lock cycle for us; tests must cover the full
order rather than only a single database deadlock detector.

## Required verification before implementation activation

Use two independent fresh physical PG17 servers, full actual schema, production-
like runtime roles and the real Message/Automation repositories. Minimum cases:

| Boundary | Required negative/interleaving assertions |
| --- | --- |
| Source retire/revoke/rotate | Each commits first: both actual owners deny with zero writes. Each waits behind prepared source: target commits first, source resolves next, retirement commits last; observe physical waits. |
| Independent target rights | ACL/member delete or downgrade, zero-row/rejoin, relation feature/creator/version, Automation owner/root/enabled and placement changes win first: deny. Target preparation first: each waits until target commit/abort. |
| Connection/restart | Kill source session after PREPARE, restart either server, lose manager: locks remain and the recorded decision is recovered. Ordinary RPC-held-lock counterexample stays a negative control. |
| Decision races | Timeout versus COMMIT, decision ACK loss and simultaneous recovery leaders select one immutable decision; stale epochs cannot decide. No COMMIT follows ABORT, even if one participant reports late. |
| Delayed preparation | Pause before PREPARE, decide ABORT, scan no GID, resume old worker: gate closure prevents terminal false-absence and eventually rolls back exactly that preparation. |
| Commit-unknown | Drop each actual COMMIT PREPARED ACK after its receipt is physically visible. Exactly one message/trigger remains; source cannot release before target receipt is proved. Retire after decision does not cancel that commit. |
| Lease/abort/replay | Expiry/cancel before decision aborts with zero effects. After decision, recovery completes the same effect. New retry after retirement denies; old committed recovery never creates a new effect identity or new authority. |
| Capacity/privacy | Saturated prepared slots, unavailable primary journal, unsupported pooler/role, orphan/conflicting/foreign GID and restore mismatch freeze admission. Bounded cleanup preserves decision evidence without exposing ciphertext, native IDs or credentials. |

Exercise the full actual participant query path for prepare eligibility: no
LISTEN/UNLISTEN/NOTIFY, temporary objects or held cursors; transaction configuration
must not leak session SET state into pooled connections. Prove actual advisory
transaction locks, member/Channel locks and source pin/job locks survive PREPARE,
connection loss and server restart. Simplified authorization tables alone do not
verify repository participant preparation or recovery.

Production readiness must separately prove PREPARE/COMMIT PREPARED/ROLLBACK PREPARED
on the exact selected connection path, role ownership, restart/failover durability,
uncached journal reads and an independently waking bounded recovery owner. SQL
named-statement support, a local probe or successful CI does not prove those facts.
No migration number, infrastructure mutation or production capability is inferred.
After contract review, an inactive coordinator/schema and actual-owner test PR can
be developed independently in private test databases. Activation must wait for
the production capability/recovery evidence above; native verification remains
separate. This proposal does not authorize a release-path or privileged direct
database bypass.

## Inactive implementation boundary

The internal coordinator and explicit Hub adapter reserve one canonical binding
digest per attempt. Its GIDs embed that complete digest, attempt number and source
or target suffix; local gates also compare exact database/role/plan fields. A
journal decision read verifies canonical binding digests and issues an opaque
internal capability; JSON copies cannot resolve a participant. Ordinary database
transactions and the existing colocated adapter keep their original behavior.
The prepared-source branch pins native grant/scope/job facts only; target member
locks and fresh statements enforce the original Human's exact consent membership
generation and current admin/owner role independently of target root/owner rights.

A completed or aborted attempt retains its binding, decision, gates and narrow
receipts. A later current proof/lease may reserve another attempt for the same
stable effect intent; the old attempt is never reopened. Target version may have
advanced through the effect's own Automation write. Each new attempt locks and
checks its current target version before historical replay, while target birth,
original source facts, owner/root, content and effect identity remain fixed.
Recovery of the old attempt continues to use its immutable original binding.
Admission is bounded to 128 nonterminal coordinations, eight per company and
10,000 retained decisions. There is no automatic tombstone deletion.

`pnpm --filter @xmatrix/db test:postgres` starts two private PG17 servers, migrates
both complete schemas, grants distinct runtime roles and exercises actual
Message/Automation owners plus the actual Hub codec/readback. This command is
part of the existing Hub package PostgreSQL CI stage. Test-only direct-path and
native fixture issuers are private modules, not production configuration or
public API. Their results do not attest Hyperdrive, native verification, provider
installation, message delivery or production failover/recovery support.
