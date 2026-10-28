# Every message someone waits on has one owner

Status: first delivery increment implemented (2026-10-26). The broader outcome
and recovery model below remains a design; the shipped boundary is described
separately and does not claim every execution is tracked.

## Why

On 2026-10-26 we read production metadata (no message text) for the 90 external
accounts registered since 2026-10-12, excluding team Spaces, QA plus-addresses and
test domains (an approximate cohort; the activation report's private
classification is the authority for KPIs):

- 90 registered, 38 connected a computer, 33 had an Agent, 31 sent a message, 22
  ever received an Agent reply, 5 sent messages on two or more days.
- Among people who had an Agent and sent messages, **9 never received a reply**.
  13 of 31 first messages went unanswered; only 4 of those people were answered
  later.
- Of 326 messages, 255 had subsequent Agent speech within 30 minutes (median
  20 s, p90 72 s). This timing proxy is not causal proof of an answer. The
  other 71 exposed these delivery and feedback gaps:

| Outcome | Messages | What happened |
| --- | --- | --- |
| Silent: no Run, no notice | 37 | The conversation's Agent had ended (exited, stopped or failed to start) and the next messages reached nobody (17, of which 8 named it); people typed in the welcome conversation, which never summons (7); later messages in a conversation that never had an Agent (7); the first message of a conversation the person had named (2); other (4). |
| An Agent took it and never answered | 21 | `runtime.startup_failed` (grok, qwen, kimi, cursor), turns that completed or were interrupted without a word, Runs that exited. Nothing reached the Channel. |
| A notice, then a dead end | 13 | "Agent launch failed: … No launch was allocated. (code)". Only the signed-out notice resumes by itself; the rest ask the person to fix something and send the message again. |

Over the same 14 days, all users together had 35 `runtime.startup_failed` Runs
(27 of them one person retrying Cursor) and 30 `runtime.turn_failed` Runs.

## The deeper problem

xMatrix keeps durable records of processes (Runs), identities (Instances) and
attempts (Launches), but **not of the person's request**. Whether a Human's
message is answered is a side effect of whichever independent mechanism happens
to take it at the moment it is committed:

| Mechanism | Takes the message when | Otherwise |
| --- | --- | --- |
| Launch dispatch | it names an Agent (`@claude`, `@auto`, picker) | — |
| First-message decision (Jev) | it is sequence 1 of an auto-named conversation | named conversations, the welcome conversation and every later message are not read |
| Live delivery | an Instance of the Channel is connected | — |
| Resting wake | an Instance rests `sleeping` or `interrupted` | `stopped`, `wake_failed` and startup-failed Instances take nothing |

Outside these windows the message has no owner and nothing happens. Inside them,
when the attempt fails, the mechanism reports its own failure, if it has a way to,
and the message is dropped. Each fix so far taught one mechanism to say one more
thing: the agentless reply (#940), the offline card (#1031), the signed-out
resend, waking Instances when their machine returns (#952), the ACP sign-in check
(#871). Each is correct, and each leaves every other path silent.

The opposite direction already has the right invariant. When someone mentions a
person or an Agent waits on one, the mention "stays with them until they answer"
(`data.message_attention.awaiting_response`). A person waiting on an Agent has
no such record. The routing product contract
(`space-agent-routing.md#product-contract`) and the registration design
(`agent-registration-composite-key.md#startup-changes-and-revocation`) both
assume "a logical invocation has one current attempt" across startup fallback;
that logical invocation was never built.

The Web has the same hole from the other side: it has no model of a message's
delivery. Whether an Agent can answer here is computed in at least five places
with different facts (the Hub's agentless check and the setup card count enabled
agents; the welcome subtracts signed-out ones but not too-old ones; the launch
choice uses `routingReady`, which ignores sign-in, version and machine; the Agents
page never looks at sign-in). Thirteen components explain "no agent answered" in
their own words and looks, and four of them end in "send again" or "check again".

## Contracts

1. **Explicit ownership.** An interpreted publication has an identified recipient,
   an author action to choose one, or a known non-task owner such as a control,
   Human mention or Automation. Missing tracking stays unknown. It never proves
   failed delivery and never authorizes a retry.
2. **Causal outcomes.** Ordinary Agent speech proves output, not completion.
   An execution bound to the source publication and its explicit final reply
   prove the Agent declared that execution complete. They do not prove Human
   acceptance. Multiple invocations settle separately.
3. **Authorized continuation.** A selected request may resume after a blocking
   fact changes. An unselected publication cannot: reconnecting a computer only
   updates available choices. D61 and the existing first-message routing scope
   remain unchanged.
4. **One presentation owner.** Each migrated path uses the original message's
   line. Existing failure cards stay in place until their domain has a verified
   replacement. Readiness is a projection; current server grants still authorize
   every selection and admission.

## Implemented increment: unaddressed publications

`data.message_asks` stores positive evidence that an ordinary Human publication
had no delivery owner when successfully interpreted. It records Space, Channel,
message, author, invocation input version and body hash. It is not a second Run,
Launch or completion ledger. The table is indexed by Channel/message and Space,
travels with Space shard moves and is deleted with its Channel or Space. Moving
a Channel to another Space invalidates its unaddressed evidence rather than
carrying an action into a new authority scope.

The canonical append records this evidence in the SAME transaction as a fresh,
unchanged, non-platform Human publication, while holding its Channel lock.
Post-commit only pushes the current projection; it cannot certify absence from
a recipient that exited after publication. Imported history does not acquire
evidence. Rows predating this commit witness remain unknown (`commit_certified`
is not backfilled). It uses the unified interaction
plan, persisted picker/Instance targets, Human attention recipients, existing
Run/Instance ownership and the persisted Automation occurrence. Controls,
connector commands and Automation messages never become unaddressed speech.
A sleeping/interrupted Instance remains owned by the existing wake path (#952),
including its offline wait. Stopped or failed continuity does not automatically
restart: an otherwise unaddressed publication can offer an explicit new choice.
An addressed failed summon retains its existing rejection card.

A new unnamed conversation or Page/passage discussion belongs to the existing
first-message decision even before that decision's row is inserted. An open or
settled decision therefore cannot produce a second chooser. An undecided failed
reading (including an empty Space) may offer the new action; an explicit
`none` remains settled. The first-message authority excludes persisted
Automation occurrences, irrespective of their display author.

The first page of the existing, authorized invocation query carries `asks` for
its selected publications and author. An Ask's historical unaddressed fact and
its current `canAsk` projection are separate: current recipients, permissions,
source changes or a settled decision remove the action. No row means unknown.
There is no historical backfill, age-based failure inference or browser retry.

The Web draws **No Agent was asked** under the original publication. Available
harnesses are explicit choices. If there are no registrations, this same place
contains the established connection steps; an existing but unusable registration
is not described as needing installation. A reader with a tracked source does
not also see its legacy connect-agents onboarding reply. Other clients keep
that compatibility reply. Neither mounting the line nor connecting a computer
submits a task.

The author's click sends `ask: true` to the existing launch-choice endpoint.
The Hub requires Human authentication, the original author, current Channel
`runtime_new_work`, current source hash/version, an unrecalled/undeleted source,
and an eligible harness. It locks the Channel and source, then claims the same
`data.first_message_launch_choices` row as the original chooser. Two devices,
Jev and retried HTTP requests cannot write different successful choices.
A settled `none` is never overwritten. A later deliberate request is a new
publication; this increment does not invent a replacement generation.

The choice captures the original input version/hash. The existing system summon
is authorized by that durable choice; its prefix or reply target alone is not
permission. Both launch ownership and initial-input provenance recheck the
original publication. Admission also retains current Channel/registration
checks. Edits, recall and deletion therefore fence late dispatch. A Channel stop
fences pending Ask choices even before a Run exists; the cancelled choice cannot
be replayed into a new launch. Already admitted work is stopped through the
existing Run fence.

The existing summon coordinator owns durable handover and transport replay.
The HTTP action awaits its wake and dispatch instead of acknowledging a
fire-and-forget promise. A lost response reuses the same choice and deterministic
summon ID; coordinator reconciliation finishes a committed unsummoned choice.
Its recovery budget begins at the explicit decision, including when an earlier
failed first-message reading was created long before it. Uncertain dispatch
continues to report uncertainty rather than allocate new work.

## Next model: invocation outcomes and fact recovery

Provider quota now has a separate, narrow [opt-in recovery owner](../operations/agent-quota-recovery.md).
It covers a refused invocation or an exhausted Instance whose ordinary handoff
found nobody eligible. It does not turn unaddressed Ask rows into automatic work
or replace the existing Instance continuation lock.

This section is the required contract for extending beyond unaddressed speech,
not a claim that those paths already use Ask rows.

### Identity and parsing

An invocation is keyed by source publication input version, selection/invocation
index and explicit generation. A resolved stable target and all machine,
repository, workspace, model and permission constraints accompany it. `auto` and
`conversation` are resolution modes, not identities. Two auto mentions or two
mentions of one harness with different constraints remain two invocations.
Retargeting replaces only the specified invocation generation, not every request
by that author.

Consume the unified interaction plan and verified publication provenance before
resolving requests. Lifecycle controls own their spans, as do connector commands;
quoted, escaped and code mentions do not create work. Automation occurrences keep
their original authority and no-mention behavior. Agent-authored summons keep
their existing intent checks and failure feedback; a Human-only Ask extension
cannot silently retire those checks.

### Outcome evidence

The execution report already binds source input/version/hash to an execution.
The final-reply fact binds Run, Instance, execution and reply body hash. Derive
completion from those causal facts, per invocation. An acknowledgement followed
by failure is not answered; a late reply to another task does not settle this
one; one recipient cannot settle the others. Old clients without execution/final
provenance remain unknown.

Execution evidence currently expires after 30 days. Until a separately reviewed
compact terminal-evidence retention contract exists, expired evidence becomes
unknown rather than a permanent inferred completion. A future terminal snapshot
must have one documented owner and be written before its causal evidence is
purged, not reconstructed from later speech.

### Recovery and cancellation

An authorized blocked request records its durable intent and fixed deadline
(24 hours from initial authorization, never extended by reconnect or replay).
An explicit provider-quota wait uses its documented fixed 35-day bound to cover
monthly subscription resets; the broader model's default remains 24 hours.
The change to its blocking fact writes a durable wake obligation. Registering a
wait rechecks the fact/version after the wait commits, so an online transition
cannot fall between observing offline and publishing the wait. Bounded batches
must durably schedule their remainder. Quota resets also need a next reevaluation
time; expiry cannot be the only timed event.

Transport replay reuses one durable intent. A genuinely new attempt atomically
increments the invocation generation. Command IDs alone are insufficient:
registration reborn's natural key includes source message and Instance. Reconcile
unknown COMMIT and sent-but-unacknowledged work before any new attempt.

The existing Instance wake lock and pending continuation own #952 recovery.
A request must claim or associate that continuation rather than independently
summon another harness/Instance. Cancellation, expiry, retargeting and final
admission compete at the same authority boundary and recheck source version,
generation and current grants. A stop can cancel queued work when no process
exists. Recalled input cannot undo external actions already taken, and the UI
must not promise that it can.

### Readiness and presentation migration

Build one typed readiness projection from registration grants, owner membership,
policy, environment, actual installed/signed-in/version facts and daemon
connection. Evaluate it for the author, Channel and invocation constraints. A
connected computer is not an Agent, an enabled registration is not proof of a
usable program, and readiness never replaces admission authorization.

Migrate preparation refusals, Run-terminal outcomes and the corresponding UI
surfaces one domain at a time, with negative and recovery tests at each owning
boundary. Startup fallback must preserve the logical invocation. Retire an old
notice only after its new path distinguishes rejection, unknown dispatch,
execution failure, output and final receipt. The composer may preview the same
projection once the migrated domains can supply it reliably.

## Verification

The first increment protects named/later/welcome publications, no automatic
launch on reload, missing history staying unknown, author identity, current
grants, two-device arbitration, Jev ownership, failed-first-message recovery,
source edit/recall/delete and stop-before-admission. PostgreSQL tests exercise
the real authority and migrations; browser tests verify the original-message
choice and exact explicit request. Existing first-message, summon reconciliation,
Run fence and launch admission tests retain their contracts.
