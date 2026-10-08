# Message interaction protocol v1

Message syntax, target descriptions and execution selection are shared protocol
contracts. The Hub owns resolution and authorization. Clients render the
permission-filtered descriptions and domain receipts; syntax never grants access.

## Grammar and consumers

`packages/protocol/src/message-interaction-grammar.json` is the versioned grammar
artifact. Rules contain literals, typed arguments, whitespace and bounded optional
sequences. The argument vocabulary and limits are part of the same artifact.
Catalogs reference rule IDs and cannot supply regular expressions or executable
code. TypeScript and Rust consume the artifact and the same test vectors; offsets
are UTF-16 positions in the original message, including on Rust clients.

The shared grammar covers runtime model/effort commands, stop/kill, reborn,
handoff, launch addresses and connector actions. Launch condition validation,
repository/path canonicalization, human-name matching and Markdown context remain
owned by their existing shared protocol modules. Retired launch spellings remain
recognizable for rejection and historical display only.

Composer field completion matches the field a candidate inserts. A `pwd:`
choice may also bind its machine, but it is offered only for `pwd:`, never
for `machine:`. Machine constraints match either the stable machine ID or
the owner-assigned name through the shared machine-tag selection rule.

`parseMessageInteraction` produces the message's interpretation plan. Whole-message
controls are exclusive with ordinary launches. Model/effort batches retain their
all-lines-or-none rule and eight-statement limit. Handoff consumes its successor
address as part of one invocation. Code, quotations, links and escaped addresses
do not become operational commands.

The Hub's post-commit entry point selects lifecycle and runtime executors from
this plan. HTTP, WebSocket and scheduled messages continue through the same
post-commit path. Domain adapters use their existing source-message binding,
current grants, idempotency keys, transactions and receipts. The protocol creates
no second Run or authorization store.

## Target catalog

`InteractionTargetDescriptor` carries a stable domain target ID, descriptor
revision, aliases, kind and operations. Operations reference syntax, input schema,
execution contract and presentation contract. `MessageInteractionRegistry` takes a
snapshot of these domain projections, rejects invalid/reserved entries, and refuses
ambiguous aliases rather than picking whichever target was inserted first.

Connector dispatch builds its catalog from installed executors and manifests.
An operation must resolve in that catalog and be accepted by the installed domain
handler. Connector policy, connection scope and credentials are still checked at
execution time. A catalog entry is not proof that the caller can perform an action.

Client-facing catalogs must be filtered by the existing domain authority. Do not
publish a raw global member/registration inventory through this registry.

## Invocation, evidence and presentation

An invocation binds the stable target, operation, descriptor revision, typed
arguments, source and Space/Channel scope. Only an authenticated domain boundary
constructs an executable invocation. Text origins bind message revision/hash and
span; automation origins retain occurrence and author authority; interactions bind
a choice or the original invocation and expected revision. A first-message
decision launches nothing itself: it is summoned by an ordinary `@<harness>` reply.

Receipts reference the owning domain's evidence. Accepted, running, completed,
rejected and unconfirmed are separate phases. In particular, accepting a stop
request is not proof that the process stopped. Presentation references select local
components; they do not contain HTML, CSS or scripts. Historical receipts keep the
resolved identity even if its name changes.

The initial presentation references are `mention.v1`, `launch.v1`, `handoff.v1`,
`reborn.v1`, `stop.v1`, `runtime-control.v1`, `connector.v1` and `launch-choice.v1`.
Web rendering consumes these contracts separately from the execution adapters.

## First-message choice

The current choice remains three seconds, including the existing display-time
extension capped at ten seconds after sending. The stored database deadline is
authoritative. An author can claim only before it; Jev can claim only at or after
it. Both contend on the same row, so only one decision wins. The winning harness
is summoned by an `@<harness>` reply whose id derives from the first message, so
an idempotent retry does not create a new launch.

An Agent's mention-free first message in an unnamed conversation uses the same
durable decision and summon. Its owner is checked through the source Instance's
registration binding. It has no Human picker window: the database deadline is
immediate, and the routing model claims the decision before the summon is posted.

Launch options represent authorized executable registrations/harnesses, not every
entry in the target catalog. Options carry explicit funding provenance; adding a
service descriptor cannot enable paid consumption. Jev recommendation does not
reserve money or establish a Run. Existing hosted AI functionality stays retired.

## Compatibility and validation

Existing exports remain adapters to the shared grammar. Existing domain wire
formats and persistent evidence remain readable; v1 descriptors do not authorize
new public mutation routes. Unknown syntax/operations are not executable.

Intentional corrections are rejection of model/effort controls in literal
Markdown, exclusive control-message launch selection, and server enforcement of
the author's stored choice deadline. Validation covers shared TS/Rust grammar
vectors, malformed/retired syntax, Unicode offsets, source contexts, ambiguous
names, catalog mutation, current domain authority tests and real PostgreSQL
late-author/Jev contention.
