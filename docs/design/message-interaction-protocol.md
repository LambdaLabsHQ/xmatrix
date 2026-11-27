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

GFM can turn a URL inside JSON into an autolink without source positions.
Context filtering recovers offsets only when the nearest positioned ancestor's
text and known plain autolinks reconstruct its source exactly. Link offsets then
follow the children's cumulative UTF-16 lengths, rather than searching for another
copy of the URL. Overlapping exclusions are merged. Entities, escapes, unsupported
structure or other unmappable unpositioned literals still reject the whole
message, and addresses inside recovered links remain ineligible.

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

Connector command presentation claims the original first-line statement from
`parseConnectorInvocation` before Markdown rendering. The Hub's execution adapter
uses the same statement parser. Mailboxes, URLs, escapes, entities and formatting
punctuation inside that span remain literal command arguments rather than splitting
the command into Markdown nodes. The remaining body keeps Markdown rendering and
its original source offsets. Quotes, code and edited messages do not acquire an
executable command chip.

A command's answer is drawn on the command, the way a summon's progress is drawn
on its `@`, and it is not a message. When the Hub answers a model or effort
switch, a stop that fenced no Run, or a refused reborn or handoff, it records the
answer as a system annotation (`xmatrix.command-result`) on the message that
wrote the command: `controls` holds one outcome per statement, in order, and
each `note` holds one fact in the Hub's words (a stop note that settles the stop
carries `stopOutcome`). When a message's `@` delivery cancels a busy live
Instance's running turn (`interruptRequested && !steerAllowed`), the Hub records
those Instances in `interrupts` on the same annotation so the sent mention chip
shows `Interrupted` live and on reload without creating another message. Messages
carry the merged `commandResult`, and a `channel_message_interactions_updated`
event applies a new annotation to every client that holds the message. Because it
is not a message, the answer neither previews in the conversation list, counts as
unread, nor wakes an Agent. `xmatrix channel history` prints it under the command
as `[result]` lines, so an Agent reads what a person sees.

A model or effort switch is decided against the Hub's own record of the
addressed Instance before and after its Runtime is asked
(`decideProductAgentSwitch`):

- A model whose provider quota a current reading shows used up is refused
  without asking the Instance, which would cancel its running turn for a
  switch the provider then refuses. The refusal names the model, the machine
  whose account it is and when the quota is back, and the outcome carries
  `quotaExhausted` (model, reset, machine, models that still have quota).
- A provider's own quota refusal that a runtime passes on (a 429 with no
  reading to explain it) is worded the same way, without a reset time.
- The Runtime is handed the catalog the Instance row stores. A Runtime cell
  that hibernated keeps a compact session without it, and used to answer that
  the Instance offered no such model.
- An Instance no cell holds is named for what it is: still starting, asleep
  until its next message, or stopped until a reborn. Only an address that
  names no Instance of the Channel is `no_instance`.
- A listed catalog marks the models that are used up (`usedUp`).

A refused switch offers the person who wrote it one step, in its answer
(`controlNextStep`), and the step is an ordinary command sent as them:

- A statement to an Instance that has a Run and no connection (starting,
  being reborn, reconnecting) waits, in the Runtime cell, for that Instance's
  next presence report (the event; fifteen seconds is only the bound) and is
  applied then. Only when it does not report in that time is the answer a
  refusal (`starting`), and it offers **Send again**.
- A model written to a resting Instance is recorded on its Run
  (`chooseWakeModel`, `wakeRuntimeModel`) and is the model its next wake or
  reborn starts on; the statement answers `switched` with `onWake`, drawn as
  "starts on <model> when it wakes". The choice keeps the Instance's kind of
  model, as every resume does: a model its registration declares, or on the
  runtime default a model of the catalog it last reported. A used-up model is
  refused first, with its reset, and a wake decides its quota by the chosen
  model. `/model` with no value lists what it last reported. An effort is
  recorded the same way (`chooseWakeEffort`), checked against the efforts of
  the model it will start on, and goes with the resume's spawn once; onto a
  runtime-default model only a daemon that carries an effort there takes it.
- A `/model` naming a model whose quota no current reading tells (the account
  unread, or its scoped part unread; a complete reading that lists no window
  for the model's scope has told it) asks the Instance's daemon
  for one fresh read: the statement is the event. The statement itself goes
  on with what is known. When a resting Instance then wakes and a current
  reading shows its chosen model used up while the model it last ran has
  quota, it wakes on that one, the choice is dropped, and a note on the
  statement that chose it says so.
- A provider refusal for quota that no reading explained asks the Instance's
  daemon for one fresh read of that account (`verifyRegistrationQuota`). The
  refusal is the event; the reading then tells the Agents page and the next
  statement which quota is used up and until when. Until it arrives, models
  that share the refused model's quota scopes are not listed as available.
- The answer's second step says who answered: the Instance, xMatrix on the
  provider's quota reading (the Instance was never asked), or nobody because
  the Instance is not connected.
- A used-up model names, in `quotaExhausted.elsewhere`, up to three other
  Machines of the Space where the work can continue on that model: online,
  running the same harness, uniquely named, and with a current provider
  reading of their own account that leaves the model quota. Only a
  repository-backed Instance has any, since a directory never leaves its
  Machine. **Continue on <machine> with <model>** sends
  `@<agent>:<n>:handoff:@<harness> machine:<machine> model:<model>`, and says
  first that it stops the Instance and starts a new one there.

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

### Connector catalog capacity

Grammar revision 2 keeps the v1 descriptor and invocation format and raises the
per-target operation bound from 64 to 256. Projection rejects overflow instead
of silently truncating installed actions. The Hub command catalog and clients
consume the same shared grammar; updated clients can present the complete
catalog. Older clients retain their existing command presentation limits, while
server execution still checks current actions, credentials and grants. This
capacity increase does not grant permission to invoke any action.
