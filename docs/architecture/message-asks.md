# Every message someone waits on has one owner

Status: proposed (2026-10-26). Draft — the model and rollout below are under
review; nothing here is implemented yet.

## Why

On 2026-10-26 we read production metadata (no message text) for the 90 external
accounts registered since 2026-10-12, excluding team Spaces, QA plus-addresses and
test domains (an approximate cohort; the activation report's private
classification is the authority for KPIs):

- 90 registered, 38 connected a computer, 33 had an Agent, 31 sent a message, 22
  ever received an Agent reply, 5 sent messages on two or more days.
- Of the 29 who had an Agent and sent messages, **9 never received a reply**.
  13 of 31 first messages went unanswered; only 4 of those people were answered
  later.
- Of 326 messages, 255 were answered within 30 minutes (median 20 s, p90 72 s).
  Speed is not the problem. The other 71 were:

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

## Invariants

1. **Total addressing.** When a Human's speech message commits, it resolves to
   exactly one of: the Agents it asks; nobody yet, shown under it with the one
   action that asks someone; or nothing to answer (a lifecycle control, a message
   to people only).
2. **Total outcome.** An ask ends answered (its addressee spoke after it) or
   closed by a person (recalled, stopped, or they asked someone else). Every
   other state names what it waits on.
3. **Resume on facts.** When the fact an ask waits on changes (an agent is in,
   the machine is online, the program is signed in or updated), the Hub continues
   the same ask by itself. No copy asks a person to send a message again.
4. **One surface.** One line under the message draws the ask, and every surface
   that says whether an Agent can take work reads the same readiness facts.

## Model

An **Ask** is a Human speech message that is owed an answer, per addressee. It is
the logical invocation the routing contract assumed: Launches, Runs and wakes are
its attempts.

`data.message_asks`, keyed `(space_id, channel_id, message_id, addressee)`:

| Column | Meaning |
| --- | --- |
| `addressee` | `instance:<id>`, `harness:<name>`, `auto`, or `conversation` (whoever is working in it) |
| `author_user_id`, `timeline_sequence` | the asker and where the message sits |
| `state` | `asking` (an attempt is under way), `waiting` (blocked on a fact that clears by itself), `unaddressed` (nobody was asked), `failed` (an attempt ended without an answer and needs a person), `closed` |
| `reason_code`, `subject`, `detail_json` | for `waiting`, `unaddressed` and `failed`: one code from a closed list, what it is about (`machine:<id>`, `registration:<owner>/<machine>/<harness>`, `space`), and the bounded public facts the line needs (program, machine name, version, minimum) |
| `attempt`, `launch_id`, `run_id`, `instance_id` | the current attempt |
| `expires_at` | waiting longer than this (24 hours) closes it as expired |

What the row stores is what no other table records: whom the message asks, why
nobody was asked, and what it waits on. Progress that other tables already record
is read from them, not copied: a Launch or wake under way, an execution accepted,
and above all **answered**, which is any speech by the addressee (or, for
`conversation`, by any Agent) after the message. A Human speech message older
than a minute with no ask row is drawn as "didn't reach an agent", so a lost
post-commit is visible rather than silent.

### Resolution (Hub, at post-commit)

In order, without new semantic routing (D61 stands):

1. **Named agents.** Instance, harness and `@auto` mentions and picker selections
   are asked; each preparation refusal becomes that addressee's `waiting` or
   `failed` state instead of an "Agent launch failed" message.
2. **The conversation's Agents.** A live Instance receives the message as today; a
   resting one wakes as today. Either makes it `conversation`, `asking`.
   Continuity does not depend on whether a process happens to be alive: if the
   conversation's last Instance ended without a person stopping it (startup failure,
   exit, wake failure), the ask names that Agent and resumes it.
3. **A new conversation's first message.** Jev's first-message decision, as today; a
   decision of "nothing" is `unaddressed`, not a dead end.
4. **Nobody.** A named conversation, the welcome conversation, or a conversation
   whose Agent a person stopped: `unaddressed`. The line offers the Space's ready
   Agents, the one most recently used first; one tap asks it on the author's behalf.
   If the Space has no ready Agent, the line is the connect step instead, and the ask
   waits on `space`.

### Outcome

- A preparation refusal for a fact that can change (machine offline, program signed
  out, too old, quota) is `waiting` with that subject. A refusal no fact will clear
  is `failed` with its action.
- A Run that ends before its addressee spoke (`runtime.startup_failed`,
  `runtime.turn_failed`, exit, interrupted, a completed turn without a reply to an
  explicit ask) makes the ask `failed`, with the program's own words and two
  actions: try again, or ask another Agent. Startup failure first tries another
  eligible registration once, as the routing contract already specifies.
- An Agent reply answers it. A recall, a stop of the addressee, or asking someone
  else closes it.

### Resume

The writes that change a blocking fact wake the Channels whose asks wait on it, the
way `wakeInstancesAwaitingMachine` already does for resting Instances: a daemon
connecting (`machine:`), a registration enabled or an inventory report that turns a
program signed in, installed or new enough (`registration:`), an agent entering
the Space (`space`). The Channel coordinator re-runs that ask's resolution as its
author with an idempotent command id per attempt; a `harness:` ask is summoned
like the first-message summon, an `instance:` or `conversation` ask is woken or
reborn. Expiry is the coordinator's only timed step.

### One surface

The Web reads the asks of the visible messages with the timeline and draws one
line under each Human message: who it went to and where that stands ("claude is
working", "Waiting for MacBook to come online, it continues by itself", "Claude Code on
MacBook isn't signed in · Sign in", "kimi couldn't start: … · Try again · Ask
claude", "No agent was asked · claude · codex"). The agentless reply, the launch
choice's settled line, the signed-out and offline cards, the "Agent launch
failed" messages and the chip notes become this line. The composer later shows
the same resolution before sending.

## Rollout

| Phase | Ships | Removes |
| --- | --- | --- |
| 1 | The table, resolution at post-commit, the read endpoint and the line, including "didn't reach an agent" | Every silent outcome: nothing a person writes can disappear without a line |
| 2 | Resume on facts; refusals write `waiting`; one readiness predicate shared by routing, the welcome, the line and the Agents page | Every "send again" and "check again" |
| 3 | Run-terminal outcomes and startup fallback write `failed`; the old notices and cards are retired; the composer preview | The parallel failure surfaces |
