# Agent registration composite identity

Status: implementation in progress; production authority has not changed.
Composite commands, Space configuration, grants, catalog reads, physical capacity
and message selection persistence have regression coverage. Run permission checks
are connected to token issuance, connection, message writes and Secret use.
Canonical Run creation is staged behind composite Space authority: stored
invocation selections dispatch a two-step reservation and a single Space commit
for Run, binding, Instance and Launch. Launch queries and live presence now
read registration display names when a historical Profile column is absent.
Shared provider-account quota is a directory observation: unknown stays
unknown, and a fresh remaining measurement of zero refuses reservation.
Owner installation is the Human CLI plus a Space registration panel. The
cutover executor can enroll unambiguous tuples only with matching immutable
evidence; the production maintenance broker still rejects write mode. None of
these preparation changes activates a Space.

The owner requested composite primary keys instead of an independent Agent
registration UUID on 2026-09-20. This changes the data model, not just mention
rendering. A hash of the tuple stored as a replacement Agent ID does not satisfy
the request.

## Product and identity boundaries

Users select an abstract harness capability, such as Codex, and the router
selects an eligible owner-registered execution location. Registration remains
an explicit owner action. Display names can repeat; owner and machine labels
distinguish locations without becoming authorization or identity keys.

The owner confirmed that owner, machine, and harness uniquely determine the
registration. There is no fourth configuration key. Configuration is mutable
registration data. Concurrent Instances, repositories, and working directories
do not create additional registration identities. Existing duplicate triples
must be reconciled with their historical references; they cannot be preserved
as separate identities by inventing another suffix.

Space membership and permission are a separate association with that tuple.
Human identity is not being redesigned. Machine identity is: the `machine_id`
column keeps its place in every key, but its value becomes derived from the
host instead of a minted UUID, and the machine name becomes a renamable
attribute (`machine-identity.md`). Invocation, command, and startup-attempt
identifiers retain their separate lifecycle roles. Instances and Runs keep
separate lifecycles but drop their minted UUIDs for natural keys; see
`instance-run-natural-keys.md`.
In particular, fallback still replaces an attempt and fences its late receipt;
changing registration keys cannot weaken that check.

## Records and keys

| Record | Primary key | Owned facts |
| --- | --- | --- |
| Machine harness registration | `(owner_user_id, machine_id, harness)` | The owner's registered installation; shared physical availability and execution limits |
| Space registration | `(space_id, owner_user_id, machine_id, harness)` | Display name, independent configuration and enablement in this Space |
| Owner grant to a Space | The same four-column tuple | Resources and operations the machine owner permits in this Space; grant revision and revocation state |
| Space usage policy | The same four-column tuple | Space-local usage restrictions and policy revision |
| Instance | `(channel_id, channel_instance_id)`, plus a structured Space registration reference | One Agent's place in one Channel |
| Run | `(channel_id, channel_instance_id, run_ordinal)`; About Runs `(channel_id, about_run_ordinal)` | One execution and its admitted permissions |
| Invocation attempt | Its existing lifecycle key | The unique startup receipt |

The grant and policy can be typed, separately versioned fields in the Space
registration row; they need not introduce surrogate IDs or additional tables.
They must have separate mutation commands and field-level authorization. The
prepared migration currently supplies identity and configuration tables only;
it is not yet a complete permission schema or an enabled authorization path.

There is one registration for a triple. Backend, executable binding and local
installation maintenance belong to the machine owner. Multiple configurations
of the same harness in one Space are not separate identities. Independent
Space configurations cover model defaults, reasoning settings, work guidance,
routing suitability, approved workspace selection, secret references and
Space concurrency limits. None of these belongs in the three-column key.
Global machine resource limits still cap the sum of Space allocations.

## Who may do what

| Operation | Authorization |
| --- | --- |
| Install/enroll or remove a local harness | Explicit action by the machine owner; installation does not itself share access with any Space |
| Offer a registration to a Space | Machine owner, subject to current Space membership and Agent-creation policy |
| Expand the machine/resource grant | Machine owner only; a Space administrator may request expansion, not approve it on the owner's behalf |
| Edit Space guidance/model defaults within the existing grant | Space owner/admin; a machine owner who is only a member controls their grant, not every Space policy |
| Disable or enable an Agent in a Space (one switch) | Its owner or a Space owner/admin |
| Launch a Run | Current Space and Channel capabilities, active grant, the Space's enabled state, the owner's enabled environment, eligible registered resources and daemon admission |
| Stop a Run | Existing Run/Channel control rules; Space administration is limited to that Space, while the machine owner retains control of their own host processes |
| Alter permissions from an Agent Run | Not inherited from its launcher; only an explicit existing typed capability could authorize such a command |

The effective permission is the intersection of the machine owner's grant
and the caller's current Space/Channel capabilities. A Space enables or
disables an Agent; it has no pause, and its stored policy limits follow the
owner's grant. A composite
key identifies a target; possessing it never authorizes an operation. Phase-one
automatic routing remains human-invoked, matching the existing API contract.
This design does not silently give Agent Runs permission to delegate or edit
configuration.

Owner grant and Space restrictions are enforced at their respective server
boundaries and again when the daemon accepts an execution. Fields such as a
browser capability description are routing evidence, not permission to use a
credential or a promise of sandbox enforcement. A backend that cannot enforce
a required restriction is ineligible for that restricted request.

## Space isolation example

The same owner/MacBook/Codex tuple can have two independent rows:

- Space A: browser interaction enabled by an owner grant, an approved project
  directory and model defaults selected for A.
- Space B: a different approved repository and model defaults, with no browser
  capability granted.

Changing B's settings or removing the Agent from B does not change A's
settings or terminate A's Runs. Neither Space can see the other's work, credential references
or configuration. They share the physical machine's capacity. The router may
receive a bounded availability/load signal without exposing other Space names,
members or work. Shared provider account quota, when known, is also a shared
resource rather than separately available credit in each Space.

`control.registration_quota_observations` is the only quota authority. Its
owner-scoped pool defaults to `registration:<machineId>:<harness>`; an explicitly
declared shared pool may join registrations. Provider observations from an
Instance's authenticated Run and completed daemon probes write the same row.
The Run registration supplies owner, machine and harness; provider metadata
cannot choose them. Original observation time determines which whole reading
wins, including a newer reading with lower usage. Token counters remain local
to each Instance.

Channel catalogs (including resting Instances), live cards and `xmatrix list`
project that row, as do routing and the Agents management page. Instance
presentation no longer persists another quota copy. Runtime delivery re-reads the owner's live Channels and focused Channels with
resting Instances, so declared pools shared across machines converge too; each
Channel resolves its own pool and membership before delivery. Reconnect/catalog
reads repair a missed notification. The Agents page retains its bounded,
shared daemon refresh cadence. No per-Instance quota polling is added.

The optional `LlmUsage.quotaState` is a server projection (`observed`, `exhausted` or
`unknown`). An expired reading explicitly withdraws the old meters,
without removing local counters. An expiry keeps the last observation time;
Web rejects delayed observations of that same or an older version, but accepts
a newer provider read. A missing reading without any observation is the oldest
version, so its delayed snapshot cannot erase the first provider read. A
usage-limit hold without named windows displays quota exhaustion without
inventing a 5-hour or weekly window. Hub and Web ship this behavior together; existing CLI
readers ignore the optional state field and receive no meters for unknown
quota. Historical message snapshots retain send-time presentation.

Agent message snapshots also carry an optional `registration` tuple
(`ownerUserId`, `machineId`, `harness`), read from the authorized Run binding
in the append transaction. Web resolves its current Machine name only from
the reader's authorized registration catalog, independently of Channel
presence. Existing messages without that snapshot may resolve their exact
Instance in the same catalog; names and Channel ordinals never identify a
Machine. If that old Instance is no longer listed, the Machine stays unknown.
This additive field needs no stored-message rewrite; existing readers ignore
it, and management notices retain their system presentation.


The MacBook being online now does not make it suitable for unattended work.
Owner availability declarations and fresh daemon observations remain distinct.
Routing unattended work excludes it unless the required availability is met.

## Startup, changes and revocation

1. Resolve the requested abstract harness/model against registrations granted
   to the current Space. Apply hard permission/resource checks before semantic
   ranking; Jev never grants access or changes the scope.
2. Reserve capacity and create an immutable attempt bound to the four-column
   Space reference, grant revision and effective permission snapshot. Keep the
   original logical invocation ID across fallback attempts.
3. Recheck current grants and membership before dispatch and at startup receipt.
   The daemon verifies its machine/owner binding and installed harness. It does
   not accept a caller's claim that an arbitrary triple belongs to it.
4. Startup failure may try another currently authorized candidate. Atomically
   replace the active attempt; a late previous wrapper fails its fence before
   receiving the initial message. Space isolation applies to every fallback candidate.

Separate ordinary configuration revisions from authorization revisions. A
rename or default-model change affects future launches and does not cancel
admitted Runs. Explicit permission narrowing revokes affected access rather
than pretending that a stale Run snapshot grants it indefinitely.

Provide two visibly different actions:

- **Disable:** one switch per Agent in a Space, for its owner and for a
  Space owner/admin. Off sets the Space's state to disabled and advances its
  execution revision: new attempts are refused and the Channel coordinators
  issue durable stops for its active Runs in this Space. On admits new work
  only. (Revoking the owner's grant, `xmatrix agent remove`, remains the
  owner's un-sharing. The physical environment's `enabled` flag also still
  stops the Agent everywhere, but no client sets it off any more; the switch
  turns it back on for an Agent turned off that way.)

An offline machine cannot acknowledge immediate process termination. Report
revocation as pending local stop until the daemon confirms it; refuse renewed
Hub authority in the meantime. Reconnect must process persisted revocation
before admitting new work. Re-enabling a grant increments its authorization
revision and cannot revive a superseded startup receipt. Owner departure from
a Space invalidates that owner's Space grants; historical messages and receipts
remain attributable without preserving live access.

## User interaction and API shape

The normal entry point selects an abstract harness and lets routing choose a
machine. An optional explicit target picker shows a name with owner/machine
labels. Its selection carries a structured four-field reference internally;
it must not insert a UUID into the editable text. Send the selected reference
with the exact mention span/message revision so edits cannot retarget a stale
selection. The server resolves and authorizes every selected reference.

Plain-text ambiguous names cannot silently choose the first registration.
An explicit-target path requests disambiguation; the automatic-routing path
can resolve the candidate set. Keep these intents explicit. CLI consumers use
named target fields or automatic routing instead of requiring users to assemble
opaque compound address strings. Message headers and details consistently show
Space display names and owner/machine labels. Editing a label changes no key.

Private secret values stay in their existing stores. A Space configuration can
hold only references that are valid for that Space and owner grant; copying a
configuration to another Space does not copy authorization. Audit records bind
the actor, Space, tuple, action and revisions without logging secret values.

## Existing dependencies to migrate

The present PostgreSQL profile table uses `agent_profile_id` as its primary key
(`0009_expand_remaining_control_facts.sql`). Managed creation requests reserve
`profile_id` before confirmation (`0015_expand_user_agent_control_facts.sql`).
Both legacy registrations and request-created profiles exist; their strings
must not be parsed to infer a missing machine binding.

The migration must cover these consumers together:

- Profile creation, owner confirmation, edits, deletion, pagination, replay,
  and Space authorization in `packages/db/src/agent-profile-control.ts`.
- Run ownership, Channel membership, message authors and recipients, execution
  records, credentials/capability bindings, and realtime projections.
- Launch targets and deduplication (`0036_expand_agent_launches.sql`), message
  execution ownership (`0047_expand_agent_message_executions.sql`), and routing
  attempts and latency lookup (`0056_expand_agent_routing.sql`).
- Structured protocol contracts, daemon registration, persisted local launcher
  configuration, reconnect and historical stop/reborn addressing.
- Composer selections and message presentation. Selection binds the tuple
  internally; users must not have to type a UUID to disambiguate a name.

## Migration requirements

The composite command boundary is gated by
`data.agent_registration_authority` in the resolved Space shard. A missing or
prepared record returns `registration_cutover_required`; clients cannot activate
it. This keeps the new canonical command API from becoming a second writer while
legacy Profiles remain authoritative. Activation requires an immutable migration
manifest and the remaining runtime/consumer cutover checks below.

`agent-registration-control` and `get-agent-registration` use current Space
placement, reject Agent principals, and bind the caller at the authenticated HTTP
boundary. The offer command uses the natural tuple, verifies global machine
ownership and does not enable execution. Duplicate offers do not overwrite Space
configuration. Configuration mutations require current Space owner/admin status
and stay within the owner grant; configuration has no installation, executable,
backend, environment-value or sandbox-authority fields. Ordinary members receive
labels and keys without privileged configuration or secret references.

Physical enrollment and its replay ledger are written only through the global
directory connection. A Space on another shard receives an immutable key anchor
for its composite foreign key, not an independent installation or permission
authority. Space authorization is checked before enrollment and again before
sharing. If membership changes between those steps, sharing fails; a retry can
reuse the global enrollment only after current Space authorization succeeds.
Registration-bearing Spaces remain blocked from generic shard movement until
their complete reference and permission movement protocol is implemented.

Both grants and policies have an ordinary revision for new dispatch/receipt
admission and an execution revision for accepted Runs. Pause/resume and resource
expansion preserve admitted execution authority. Resource removal, revocation
and re-enabling advance the relevant execution fence; subsequent expansion cannot
resurrect a revoked execution. A positive concurrency reduction governs new work;
zero withdraws execution authority.

`data.run_agent_registrations` binds a Run to its natural Space key, initiating
Human, admitted resource set, authorization revisions and global allocation.
It does not own Run lifecycle. Token issuance and refresh request an execution
read from the owning Space. Instance connection, message writes and Secret
requests also recheck the binding; Secret checks use the exact requested aliases,
not just the existence of a current grant. History reads remain available under
their existing read authorization. A composite Space refuses execution without
a binding, while a prepared Space cannot execute a new composite binding.

Transitional exception: entry points that do not yet launch through a
registration still create Profile Runs after cutover. These are Focus review,
Channel About, `@xmatrix` management activation, management `agent_dispatch`,
direct-conversation wake, Automations, handoff and
`@ProfileName:new` for a name that is not a registration. In a composite Space,
such a Run is admitted only under the registration its Profile was cut over to
(`control.legacy_agent_registration_references`). That registration's current
grant, policy, owner membership and the summoning Human's Channel capability
govern it as new work. A Profile with no mapping is refused. Each entry point
moves to a registration launch, and when none remain this exception and its
mapping are deleted.

New startup requires a confirmed machine-command lease before the global
allocation can be admitted. Token renewal checks the existing admitted
allocation without consuming another slot or requiring its original daemon
connection epoch. Stopping/released allocations cannot authorize renewal. Exact
process-terminal evidence overrides allocation state even beyond the bounded
cleanup batch; terminal backlog does not consume available machine capacity.
Physical resource decisions and Space permission decisions remain independent.
Run preparation now has a durable staged intent followed by global reservation
and a single Space commit for Run, registration binding, Instance, Launch and
outbox. Unknown reservation/commit outcomes retain the exact attempt for retry.
Definite aborts prove the Run absent before a global tombstone fences any late
reservation and releases only unadmitted capacity. Bounded reconciliation checks
source edits, revocation and membership loss and retries incomplete cancellation.
Dropping the legacy NOT NULL Profile columns remains a contract cutover
statement, not an expand-only production apply. Isolated tests exercise that
nullable contract. Launch queries, diagnostics and Channel presence no longer
inner-join Profiles, so a registered Run remains visible under its Space
display name.

The versioned `RegistrationLaunchBinding` carries the natural Space key, exact
Run/Instance/allocation, authorization digest, physical declaration revision,
logical resource references and resolved provider model. Startup compares it
with the authoritative Run binding before admitting capacity. An environment or
provider-model mismatch cannot consume the reservation. This does not replace
the independently confirmed machine-command lease.

For a registered launch, the legacy-named transport `identityId`/`agentId`
carrier identifies its execution actor, which must equal the bound Instance ID.
It is never a Profile reference or a replacement registration key. The
registration envelope is the explicit discriminator; consumers must not infer
this mode from a display name or metadata flag. Historical Profile references
remain absent on new Runs and Launches.

The Hub maintains the registration registry and is the only harness preset
authority (owner decision, 2026-09-23: "注册表要有，但是hub统一维护"; presets
"不能存在本地"). Every `machine_spawn_agent` carries the Hub's `harness` spec,
and a registered launch carries its launch settings (runtime, arguments,
backend, sandbox, reviewer) from the Hub registration. A daemon advertising
`registration_launch_v1` keeps no installation record: it refuses a registered
launch whose Hub preset is missing or names a different harness, and it still
refuses a binding for another owner, machine or execution. The only local
step is finding the launcher binary on the machine. Registered launches do not
fall back to a same-name legacy Profile or inherit its environment. The current
registered path accepts an exact existing workspace; managed workspace, remote
checkout, worktree and workflow-policy overrides remain rejected until a separate
admitted materialization contract is connected. The registration's own
instructions are the Run's trusted initial prompt; the retired Agent Role adds
nothing to a launch.

The Human owner CLI provides `agent add <harness> --space ...` (the registration
`create` command: declare, offer, grant the owner's Workspaces on the machine,
enable), `agent list`, `agent show` and `agent remove`. Agent Run processes cannot
invoke these owner commands. `agent add --workspace <dir>` registers the directory
first when it is not a Workspace yet. `create` on an existing registration is the
owner's add-back: Workspaces registered on the machine since the grant was last
written are configured and granted (the Space policy follows the grant, as an
owner-grant change does), a revoked grant becomes active, and a named default
Workspace is routed to. Already granted Workspaces keep the Space's configuration,
and a Space's disable is left in place.

Owner-grant edits and add-back share one transaction-local grant writer, including
revision/fence calculation, policy-limit synchronization and reconciliation
records. Each command retains its own authorization, row locks and replay check;
configuration changes made by add-back roll back if that grant write fails.

Revocation coordination persists an exact Run/Instance/host stop intent and
cancels unaccepted Launches in the same shard transaction as the stopping
lifecycle event. A bounded leased worker retries delivery across host outages;
expired commands receive a new delivery ID without changing the execution
target. Silence, a queued command, or mismatched completion evidence never frees
admitted capacity. Only authenticated terminal evidence in the global machine
route permits release and lifecycle finalization; a reservation that was never
admitted may be cancelled directly. Finalization uses fresh lifecycle versions
and refuses to mutate a reborn successor. Access-change ledger entries complete
only when no affected live execution or pending physical stop remains. Pause
preserves accepted execution while preventing queued starts. Discovery errors
are reported without starving existing durable stop obligations.

Versioned invocation selection envelopes bind structured capability/registration
intent to the authoritative message revision, body hash and exact UTF-16 span.
The parser rejects cross-Space, overlapping, stale, quoted and escaped selections.
The message append transaction now checks current Human/Channel eligibility and
persists the envelope in the message-owned invocation target record. Explicit
spans are excluded from legacy name resolution without changing other mentions.
The invocation source reader locks and checks the stored body/input revision;
reactions preserve the input revision, while edits and recalls invalidate it.
The shared main/thread composer emits these envelopes after final body
normalization. Its capability list has one entry per harness; an explicit
location binds the natural key and retains a visible owner/machine label.
Channel draft restoration, thread materialization and bounded HTTP retries
preserve that selection. Editing inside a selected token, or deleting ambiguous
repeated labels, requires a new selection rather than guessing a replacement.
Post-commit Human messages now consume stored selections through
`registration-launch-dispatch`. Capability selections choose among currently
authorized locations; explicit registration selections keep their tuple.
Accepted selections remain intent, never a resource or execution grant. Production
cutover still requires inventory evidence and the contract migration gate.

The first production inventory uses the existing immutable maintenance broker
with `operation=agent-registration-audit`, `dry_run=true`, and `max_rows=10000`.
It inventories every legacy Profile in the Lambda Labs Space (bounded at 500);
the row-limit input does not expand that scope. A frozen Profile list was the
first scope and failed both production runs once Profiles had been deleted. Both broker and executor reject
write mode. The database transaction is explicitly read-only. Its artifact
reports tuple bindings and collision codes, never configuration or credentials.
This operator prepares a cutover decision; it cannot perform the cutover.

The read-only fleet inventory (`operation=agent-registration-fleet-audit`)
reports every Space with legacy Profiles on every shard, with the same
`evidenceSha256` the per-Space audit computes. It is the evidence for the fleet
cutover.

The cutover uses the same broker with `operation=agent-registration-cutover`.
Its scope and evidence come only from the tagged release:
`packages/db/scripts/agent-registration-cutover-receipt.json`, which a reviewer
commits with the fleet audit run id, the authorizing message, and one
`{spaceId, shardId, evidenceSha256}` entry per Space copied from that artifact.
A Space whose only audit issues are unverified machine bindings may name
exactly those Profiles in `retiredProfileIds`; they get no registration and no
legacy reference. With `dry_run=true` it re-reads each inventory and verifies
its digest; with `dry_run=false` it writes each Space in its own transaction,
under that Space's authority row lock and only if the fresh inventory still
matches its entry. A refusal stops the run and reports the Spaces already done;
a re-run skips them as already composite with the same digest. Each Space gets:

- the machine registration, Space registration (the Profile's visible name and
  every Workspace its owner registered on that machine) and the legacy Profile
  reference;
- the Hub-maintained environment: the Profile's routing declaration and its
  launch settings (runtime, arguments, backend, ACP arguments, reviewer,
  sandbox), so no machine needs a local record;
- an active owner grant and enabled Space policy with the Profile's former
  reach; and finally
- `agent_registration_authority.mode='composite'`, keyed by the evidence digest.

A Profile whose launch settings cannot be expressed as a Hub registration is an
audit issue (`unmigratable_launch_settings`) and blocks the cutover.

1. Inventory registrations and their authenticated machine bindings. Report
   missing bindings and tuple collisions; never guess from display names,
   silently merge different configurations, or generate synthetic machines.
2. Expand the schema with explicit tuple columns, composite uniqueness and
   matching references. Backfill only verified, unambiguous registrations in
   bounded transactions with durable progress evidence.
3. Introduce versioned structured references across Hub, daemon and clients.
   During compatibility, legacy references resolve through one bounded mapping
   to the same authoritative tuple, never through an independent second writer.
4. Verify active Runs, historical messages, receipts, permissions and command
   replay before switching authoritative reads and writes to composite keys.
   Record unresolved rows and do not declare cutover complete while any remain.
5. Retire UUID-based registration creation and addressing, then remove the old
   primary-key field and compatibility mapping through the approved contract
   migration process after old clients and live executions no longer need them.

Acceptance requires actual composite database keys and references, not a new
presentation alias. Regression coverage must include repeated display names,
same-harness registrations on different machines, owner/Space boundaries,
rename stability, concurrent registration, command replay, reconnect, late
startup receipts after fallback, and migration recovery. Production cutover
needs inventory, row-count/reference reconciliation and immutable release
evidence. The already authorized 25-profile display-name operation is separate
and must not be presented as this identity migration.

## Unobserved runtime model defaults

A model and a harness are unrelated values; no `models` list carries a harness
name and no launch path compares the two. The allowed models of a registration
are its Space configuration models intersected with the owner grant, the Space
policy and the physical environment, compared literally.

- An empty list (nothing declared) allows no model override. The runtime
  default is the only option: the launch requests no model resource and omits
  both `context.requestedModel` and `context.requestedEffort`, and the runtime
  chooses its own defaults. The decision evidence labels this choice `Harness
  default`. An explicit `model:` or `effort:` tag cannot be satisfied.
- A non-empty list is the complete allowed set. Jev chooses among the observed
  runtime catalog entries it allows (an owner alias maps an allowed model to
  the runtime's model id), or among the allowed models themselves when the
  observed catalog names none of them.
- Declared models that the grant, policy or environment leave empty make the
  registration ineligible; they never widen into the runtime default.

Admission compares the requested model resource literally with the grant and
policy limits.

The durable launch request records `useRuntimeDefaultModel` for exact replay.
Daemons advertise `registration_model_default_v1` when they preserve an omitted
model override rather than repopulating it from the registration binding. Hub
routes default launches only to such daemons; the additive capability gates the
Hub/CLI rollout. An explicit override continues to resolve to the bound model.
Reborn preserves whether the original launch omitted that override. No grant,
model-resource identity, allocation fence or provider catalog is inferred from
the default choice.
