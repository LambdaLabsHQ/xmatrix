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

A target carries at most 64 operations (`limits.operations` in the grammar
artifact). A connector's projection lists `policy`, `subscribe` and
`unsubscribe` first, so the operations that control a connector always fit, and
a Hub test fails when any manifest declares more than the registry resolves: an
operation past the bound is accepted as a message and then never runs.

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

A command's answer is drawn on the command, the way a summon's progress is drawn
on its `@`, and it is not a message. When the Hub answers a model or effort
switch, a stop that fenced no Run, or a refused reborn or handoff, it records the
answer as a system annotation (`xmatrix.command-result`) on the message that
wrote the command: `controls` holds one outcome per statement, in order, and
each `note` holds one fact in the Hub's words (a stop note that settles the stop
carries `stopOutcome`). Messages carry the merged `commandResult`, and a
`channel_message_interactions_updated` event applies a new annotation to every
client that holds the message. Because it is not a message, the answer neither
previews in the conversation list, counts as unread, nor wakes an Agent.

Live annotations and history snapshots merge by fact, through the protocol's
same command-result reducer. A partial snapshot retains notes absent from it;
each note's annotation id deduplicates replay, and its recording time keeps a
late read or event from undoing a newer wording. Equal-time notes sort by id.
A notes-only snapshot retains the command's statement-ordered control answer.
A recalled message still clears its judgments. The wire shape is unchanged;
older clients continue to read the same result fields.

What the Hub asks of one Agent Instance (continue a turn a switch cancelled,
retry a turn capacity cut short, co-write a page) is an instruction to that
Instance, not something said in the Channel. A switch continuation goes as an
`agent_switch_continuation` frame on the Instance's own socket to a runtime that
lists `switch_continuation_frame`. The rest, and a continuation for an older
runtime, are committed in the Channel log as its durable inbox (a resting or
reconnecting Instance still reads them), with a kind in
`AGENT_INSTRUCTION_MESSAGE_KINDS`: no person reads them, so they never preview in
the conversation list, count as unread, or take a timeline row.

Machine facts about a Run a message asked for answer on that message too: a
summoned Run's failed start or fallback is a note on the summon (shown on its
chip by `runId`), and a channel stop's failed or cleanup result is a note on the
stop command. A Run nothing in the Channel asked for still posts its notice.

## First-message choice

The author has three seconds to choose, counted from when they see Jev's reading
rather than from sending (`FIRST_MESSAGE_LAUNCH_WINDOW_MS`, plus
`FIRST_MESSAGE_LAUNCH_SEEN_MS` for the reading to reach their screen). The window
never closes later than thirty seconds after sending
(`FIRST_MESSAGE_LAUNCH_HOLD_LIMIT_MS`). The stored database deadline is
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
