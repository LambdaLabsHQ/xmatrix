# Auto invocation and keyboard completion

`@auto` summons a suitable registered environment, selected through Jev.
Runtime addresses such as `@claude` and `@codex` are peer top-level summons:
`@codex repo:owner/repo model:m effort:high` uses the same conditions and
routing authority, with the addressed runtime as an explicit constraint.
Legacy `@auto harness:codex` remains accepted; a contradictory harness tag
on a direct address is rejected. Instance addresses such as `@codex:1` retain
their existing meaning. Roll out the shared protocol, Hub and Web together;
older Hubs reject conditions on direct runtime addresses.
The complete Channel message and its surrounding context reach the Agent
through the ordinary delivery path. `@xMatrix` retains its
management-assistant meaning. Auto uses the existing
Channel launch and Space routing authorities. Explicit Profile/Instance and lifecycle mentions remain compatible.

## Composer

The same `@` search offers Auto, authorized repository references, registered
directories, machine labels, declared/reported models, reasoning effort and
harnesses. Selecting a condition establishes an Auto invocation automatically;
users need not learn a parameter syntax. Directories bind their exact machine.
The message text is the source of truth. There is no separate request field or
selected-condition header. The native textarea contains the complete message;
an aria-hidden background projection highlights mentions without changing its
text, selection, caret, or IME behavior. The parser interprets each recognized
mention in the committed message without creating a separate request field.

Harness-first selection inserts a direct runtime address. Runtime rows show
the address; other completion rows show `key:value` spelling. Both
`@repo:owner` searches and direct fields such as `@auto repo:owner` are supported.
Direct fields complete only immediately after a summon, not in ordinary prose.
An explicit completion replaces only the active fragment, preserving all other
characters, including field order, quoting, whitespace, and other summons.
Conditions after a summon insert a field; a fresh Auto choice inserts another
summon. Selecting a runtime on an unfinished summon replaces its address and
preserves its condition values. Other condition picks preserve existing text.

Arrow keys navigate and Tab/Enter accept a candidate. After selection, the
remaining suggestions are passive: typing continues the message, while
ArrowDown activates the list again. Escape dismisses suggestions. IME retains
its normal key handling. Sending preserves the message verbatim, including
malformed or retired syntax, for server-side parsing and execution. Syntax is
not a client-side send gate; whitespace-only drafts retain the existing rule.
Suggestions and highlights do not grant authority or promise availability.

## Portable text

The stored/CLI representation is `@auto repo:owner/repo model:m effort:high`.
Conditions are `key:value` words after the mention, in the grammar the rest of
`@` already uses: a colon separates, and a value carrying whitespace is quoted
with doubled quotes exactly as a workspace tail is (`pwd:"/Users/me/my work"`).
Fields are `repo`, `pwd`, `machine` (stable ID), `model`, `effort`, `harness`,
`launch:force`, and runtime-discovered `param.<id>:<value>` choices.
`fast:on` is the `param.fast:on` alias when advertised. Generic parameter IDs
and values come from runtime snapshots rather than a list of tag names in the
composer. See [harness parameters](harness-parameters.md) for discovery and
rollout boundaries. Order is arbitrary. Invalid or duplicate values prevent launch.
A completed turn leaves the Agent available for follow-up messages. Prompts tell
Agents that they can stop, reborn or hand off Instances, their own and other
Agents' alike, but never steer them to stop themselves. Existing idle sleep,
wake, explicit stop and Automation execution deadlines remain separate
lifecycle mechanisms.

The retired `:new`/`:once` actions and lifecycle tags are rejected. There is no
lifetime choice in the API, routing evaluator, decision evidence or daemon spawn.
Bare harness summons, composite registration launches and
routing HTTP requests use the same lifecycle.
Repository worktrees and existing registered directories are mutually exclusive.
The composer has no retired start-action schema, target stage, or suffix
insertion helpers. Sending a restored old draft preserves its text for server
validation instead of rewriting its dangling suffix into another old command.

The message continues at the first word that is not a condition, so an unknown
key is ordinary prose rather than an error. Repeated, conflicting or invalid
fields still fail closed. Markdown examples, quotes and links do not execute.

The parser executes each recognized mention in the committed message. Each
invocation is prepared under a command id derived from the message and its
position, stable across replay. One malformed invocation reports its own
error without changing how the others are parsed. Agent
publications use the same owner-bound Channel authority as
existing lifecycle and stop commands; they do not acquire a Human session or
bypass current Channel grants. Exact `@agent:ordinal:stop` and `/kill` remain
available to Agent authors as well.

The bracket block this invocation first shipped with, `@auto[repo="owner/repo"]`,
is gone rather than tolerated: it spent characters the grammar had already
assigned — a mention may itself be written inside brackets — and escaped values
as JSON rather than the way every other quoted tail does. A body still carrying
it is not a mention, so it reads as the prose it looks like and starts nothing.

## A new conversation's first message

A new conversation (a Channel still automatically named: the web's New
conversation, or `xmatrix channel create` without a name) needs no mention to
start an Agent. People and Agents are treated alike: when its first message,
whoever wrote it, summons nobody, the Hub asks Jev whether the author wants an
Agent to start now (`START_INTENT_CATEGORIES`: `summon` or `conversation`) in
the same call that chooses the harness. A decided harness is never launched
from there: xMatrix replies to the first message with an ordinary
`@<harness> launch:force` message (`launch:force` because whether to start is
already decided). That message's author is xMatrix itself (`system:xmatrix`),
and it launches as the first message's author: the launch authority accepts a
`system:xmatrix` source only as `xmatrix-summon:<first-message-id>`, and only
for the author of that message's recorded `start` decision. The message goes
through the same post-commit pipeline as any summon: Jev chooses the model,
directory and machine, the launch is prepared and delivered, and the reply
shows the launch status and any refusal. There is no separate first-message
launch path. `conversation`, missing Jev configuration and every refusal start
nothing and post nothing, because the author never asked for an Agent;
refusals other than `start_intent_declined` go to the Worker diagnostic log. A
first message with a mention or picker selection keeps the ordinary summon
path, a named Channel is never asked, and later messages are never asked. The
send answers first; Jev reads the message in the post-commit background work,
so the author never waits on a judgement they did not ask for.

When a Human wrote that first message, its author also gets a three-second
window (`FIRST_MESSAGE_LAUNCH_WINDOW_MS`) to choose, counted from when they see
Jev's reading: its pick, "start nothing", or why it could not read. Until then
the card offers the choice without a countdown. Jev's reading is written as
soon as Jev has chosen the harness, and that starts the Hub's deadline
(`FIRST_MESSAGE_LAUNCH_SEEN_MS` is added for the author's next refresh). The
author's `launch-choice` with `shown: true`, sent when the reading appears,
moves it on. Nothing extends it past `FIRST_MESSAGE_LAUNCH_HOLD_LIMIT_MS` after
sending, and Jev re-reads the deadline until it has passed. Whether the choice
is still open is the Hub's own `open` in each record, never a comparison with
the reader's clock. The web shows the Space's routable harnesses and "Don't
start" under the message, marks Jev's pick as soon as Jev has one, and drains a
brass rule over the window. `data.first_message_launch_choices` holds the
message's one decision; its `choice` is written once. The author's pick
(`POST /api/channels/:channelId/messages/:messageId/launch-choice`, author only,
body hash checked) writes it at once and posts the `@<harness>` reply. Jev's
reading waits until the window closes and then claims the same row; if the
author already chose, Jev posts nothing, so a message never summons two Agents.
The reply's id derives from the first message, so a retry appends and launches
nothing new. The invocation query returns the row as `launchChoices`, so the
message shows one line saying which harness was picked and whose pick it was;
when Jev could not read the message and nobody chose, that line gives the
refusal's cause instead. Only a fresh first message, within the hold limit,
opens its author's window: reopening an older conversation shows how its choice
ended and never counts down or reports `shown` again. An Agent-authored first
message has no window: Jev's reading decides at once and posts the same reply.

## Routing and rollout

Replay recovers the durable launch before querying candidates or evaluating
Jev. The published Channel message is the invocation source; no duplicate body
is supplied to launch authority or checked against a second hash. Jev sees
the message with each summon reduced to its written address, so machine IDs and local
directory tags are omitted from semantic input while the address remains.
Explicit constraints are reapplied transactionally at
allocation and receipt and remain in persisted requirements during startup
fallback. Explicit directory selectors survive fallback too.

Omitted execution location uses an owner's registered default directory. Auto
does not invent a repository or filesystem path. Missing Jev configuration,
abstention and unavailable candidates produce a Channel notice rather than an
unconstrained fallback. Model and effort defaults remain the selected runtime's
defaults when omitted; this version does not infer arbitrary provider settings.

In a composite Space, the registration candidate set is filtered by each
explicit condition before Jev is called. A condition that leaves no authorized
match records its own bounded rejection code, including an unavailable
repository or directory. Jev provider and answer failures record the decision
phase and an allowlisted cause. `xmatrix diagnose` and the invocation card
present the rejection; no server-selected fallback is introduced.

Effort travels in typed spawn context. Daemons advertise
`machine_routing_effort_v1`; older daemons are excluded only when an effort is
requested. Codex validates against its model catalog, Claude applies its validated
effort setting, and ACP requires an accepted effort change before message execution.
Deploy supporting CLI daemons before offering explicit effort on those machines.
A registration with no declared models runs the runtime's own default model; an
explicit effort applies to that model. Its daemon advertises
`registration_default_effort_v1`, and older daemons, which drop an effort that
comes without a model, are excluded when one is requested. No model is named or
chosen for such a launch.
No schema migration or production deployment is implied by this implementation.

## Verification

Focused coverage includes protocol round trips and invalid syntax, Markdown
literal exclusion, machine/effort eligibility, Jev abstention, replay recovery,
and omission of local-path tags from Jev input. Browser coverage exercises
repository-first selection, adding a model, ordinary prose typing, Auto without
parameters, and continuing with arrow keys. PostgreSQL 17 integration exercises
explicit-directory/effort preservation across fallback together with the
existing allocation, receipt-race, replay and expiry tests. Rust tests cover
typed spawn-context deserialization and daemon handoff of requested effort.

Scoped Worker lifecycle integration tests seed structured launches explicitly
through the test-only `lifecycle-launch` fixture. It commits an ordinary message
through the authenticated product route, then uses the existing scoped launch
port; it neither parses retired syntax nor appears in the production entrypoint.
This keeps daemon lease, reconnect, stop, cleanup and cross-user authorization
checks independent of the removed `:new`/`:once` grammar. Scheduled-message and
interactive rejection tests still exercise that grammar through real product
message delivery. Auto parsing/routing and PostgreSQL allocation tests remain
the coverage for the supported launch contract, not the lifecycle fixture.
