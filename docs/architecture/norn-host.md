# Norn host: programs in a conversation

How xMatrix runs a [Norn](https://github.com/norn-lang/norn) program: the
first version, in which Agents answer each other's typed requests with no
person in the loop. The design and what comes next are on
page:803a0ba8-5d0f-4f28-ae7f-36f0b5e6e307; the language is in the Norn
repository, and the Hub carries a
[pinned snapshot](../../packages/hub/src/vendor/norn/README.md) of its
checker, evaluator and ledger.

## What a program is

A message whose Markdown has one top-level fenced block tagged `norn run` is
a program. A block tagged `norn` is only shown, and so is one inside a quote.
The message is the program's identity: seen again, it starts nothing. People
and Agents start a program the same way, by sending the message.

The Hub checks the program when the message is committed. A program that does
not check starts nothing, and a reply under the message names the line and
column of each error. One that checks runs with its author's authority: the
person who wrote it, or the owner of the Agent Run that did.

## Programs on a Page

A Page is where a program lives; a message is the ad-hoc way to run one. Each
top-level `norn run` or `norn 1 run` block of a Page is a program. The word
after `run` names it (`norn run review` and `norn 1 run review` are the same
program identity); without one it is `main`. A name is one word:
a letter, then letters, digits, `_` or `-`, at most 40 characters. The Page
and the name are the program's identity, so editing the block's text or moving
between `norn run <name>` and `norn 1 run <name>` keeps the same running
program and open requests. A block written with an unsupported edition (such as
`norn 2 run review`) is still recognized under that name with a problem message
so syncing never stops a running program. Two blocks with one name run nothing
until one is renamed, and nor does a block whose name is not a name. What a
block's info string makes of it is one function, `nornRunBlock` in protocol,
which the Hub and the Page editor both read, so no block is drawn as a program
the Hub passes over: every block tagged `norn run` or `norn <edition> run` is
listed, and one that runs nothing carries why. Typing the fence keeps that
whole string. A space opens an ordinary one-word language (`` ```ts ``). Enter
opens a fence whose info has a space in it (`` ```norn run review ``,
`` ```norn 1 run review ``, `` ```norn run 物业费 ``).

A saved revision is synced (`syncPagePrograms`, from the Page session's
commit, a new Page, and a restored revision), as whoever wrote it:

- A new block that checks starts its program.
- A changed block revises its running program: the same ledger is evaluated
  against the new text, so what was already asked in the same words stays
  asked and nothing is asked twice. A change that does not check is not
  applied.
- A block changed after its program ended runs again.
- A removed block, or a removed Page, stops its program.

A person who deletes a program's conversation ends the program: it goes with
the conversation, whose identity is never used again. Its block stays on the
Page and runs nothing; the Page says so, and renaming the block makes it
another program with a conversation of its own. Every block is tried in a
sync: one that cannot be brought up to date fails the sync without keeping
the others from starting.

The sync is owed from the commit until it is made. The Page's session stores
what it owes (`programsDue`) before the work and clears it when the work is
done, and the event that committed the revision waits for it. A sync that
failed, hung, or that the session did not live to finish is made again from
the session's alarm, later each time, until it succeeds; syncing twice starts
nothing twice. Whoever saves while a sync is owed is told so in the edit's
`scheduleProblems`.

Each block has one conversation for its whole life, named for the Page and
the block and linked to the Page. Every run opens with xMatrix's message
carrying the program's text, and its requests and result follow in that
conversation. `GET /api/spaces/:space/pages/:page/programs` answers, for
whoever can read the Page, how each block stands: its state, why it does not
run as written, each request with its holder, outcome, reply and times, and
what it does next. The Page draws that as the program's flow, joined under
the block (`page-program-chips.ts`).
`xmatrix page read` prints the same under `programs:` in its header, one
line a block: its state, its conversation, how many requests it made and how
the latest stands.
A whole-document edit answers with each block that does not run as written
and why (`nornProgramProblems`, in the edit's `scheduleProblems`), so an
Agent that writes a program reads the checker's words at once. What only the
sync can know, a block whose conversation was deleted, is added when the
edit's sync finished before the answer.

## What it does next

A reader of a program wants to know what it will do, not only how it is
written. The Hub reads that off the program itself (`nornFlow`,
`norn-plan.ts`). A program is a pure computation over its ledger, so its
future is the same computation on a copy of the ledger: the clock is moved to
the time it waits for, an outside event it waits for is made to occur, and
each request it waits on is ended every way it can end (each answer its type
allows, declined, could not, no answer in time). The steps that follow each
way are read the same way. Ways that lead to the same steps are one; where
they lead apart, the others are branches of the request. Nothing is written:
the ledger, the requests and the conversation stay as they are.

The result is the program's flow from this moment, beginning with what it
waits for now: a time or an event, whom it asks what and under which
conditions, what it says, how it ends. A loop is one round and the way back
to its wait, with the beat it keeps; a function that calls itself goes back
to the request it asked before. The standard library needs no reading of its
own: `routine(…)` is evaluated like any other text. Each evaluation copies
the ledger, so the reading is given a number of evaluations that shrinks as
the ledger grows, follows the main line first, and says where it stopped.

The flow comes with a program's status (`next`), for a Page's blocks and for
the program a message carries: `GET /api/spaces/:space/norn-programs/:message`
answers how that program stands, for whoever can read its conversation, and
`null` for a message that is no program. The Web draws one flow
(`program-flow.ts`): under the block on a Page, and over the program's text
in its conversation, where what a request asks is read in full. A block that
has not started is drawn from an empty ledger, so its flow is there before
its first pass.

## State

`data.norn_programs` holds one row per program: its source and its whole
request ledger as one JSON value. The ledger is the only authority for what
was asked, of whom, and what was answered. A program stores no position:
every pass evaluates it from the top against the ledger
([Norn spec §9](https://github.com/norn-lang/norn/blob/main/docs/spec.md#9-execution-model)).

`data.norn_requests` is an index of the requests that are delivered to
someone, written in the transaction that writes the ledger. It finds a
request by the reference its holder answers with and by the message that
delivered it. It holds nothing the ledger does not.

`PostgresNornProgramRepository` (`packages/db/src/norn-programs.ts`) holds the
program's row while a caller-supplied step runs; `nornStep`
(`packages/hub/src/norn-host.ts`) is that step. A step reads the row and the
database clock and returns the new ledger; it does no I/O.

## One pass

In order:

1. A stop recorded for the program ends it and cancels what it left open.
2. The answer this call carries, if any, settles its request, or is refused
   with the reason.
3. Each delivered request that nobody works on any more is settled `Broke`.
4. The program is evaluated from the top. A request this host cannot deliver
   is settled `Broke` at once with the reason, and the program is evaluated
   again, so it reads the failure in the same pass.

A pass runs when a program starts, when its holder answers, and from the
Channel's coordinator (`reconcileNornPrograms`, step `norn` of
`RelayPostgresAgentLaunchCoordinatorService.runChannel`) when a program was
stopped, a deadline is due, or a request was abandoned. The coordinator's due
read (`NORN_CHANNEL_DUE_SQL`) selects exactly what that step acts on. Nothing
polls.

Authority revocation is handled at two distinct layers:

1. **Connector or resource permission revocation**: when an app connector's
   permission is denied or revoked (at `prepare`, at `perform` claim, or during
   durable execution), only that single request settles as `Revoked` (while the
   reason is posted to the conversation). The program or loop itself stays alive
   so it can match `| Revoked => ...` and recover (e.g. wait on `Holds`).
   Explicit human decline on an approval card stays `Refused`.
2. **Program author leaves the Space**: removing the program's `authority_user_id`
   from `data.space_members` stops all of their running programs in that Space
   (`NORN_AUTHORITY_LEFT_SPACE`), cancels open requests, and wakes their
   coordinators immediately.

## Delivering a request

This version delivers to a harness by its name (`@codex`, `@claude`, …) and
to `@auto`, each delivery starting a new Run, and to a person by name (below).
A program that names an Instance by its address has its request settled
`Broke` with that reason; an Instance holds a request only when its holder
delegated it there ([Delegating](#delegating)). A request offered to several
with `anyOf` is taken for the group by the first of them this host can reach.

The coordinator posts one message per holding, as xMatrix, in reply to the
program's message. Its id is `norn:<reference>:<epoch>`, so a repeat appends
nothing. Its first line is the holder's summon. Everything the program wrote
(the task, `~about`, `~context`) is quoted in fenced text, which never
summons or commands anyone. The message states the form the answer must have
and the three commands that end the request. It tells the holder that what is
left for a person to do or decide goes to them as a card (`xmatrix ask`,
`confirm`, `choose`) before it answers, because words in an answer ask nobody.
Where a person holds or held a request of the program, the holder is told to
say in the conversation what it does, as on a task from them; Agents that work
for one another alone say nothing but their answers. All of that is for the holder
alone: the message marks where it begins (`metadata.nornAnswerFrom`), and a
person reading the conversation is shown only what comes before it, the
summon and the request's reference drawn as the request.

The delivery message may start a Run for the program's authority and nobody
else (`NORN_DELIVERY_SOURCE_SQL`, used by the launch source rule and by the
Run's initial message source), so the Run's first turn is tied to it.

## Answering

Requests belong to the Hub, not to the language, so the commands are
top-level and [defined on the Hub](hub-cli-commands.md):

- `xmatrix reply <request> '<answer>'`
- `xmatrix refuse <request> '<why>'`
- `xmatrix broke <request> '<why>'`
- `xmatrix requests`: the open requests the Run holds and those its
  Instance's programs wait on.

Only the Run a request was delivered to holds it: the Run that the delivery
message started, or one whose turn took that message. The check reads launch
and execution records, never a name the caller gives. The answer is written
the way Norn writes values (`Sound`, `Flawed("no owner on failure")`). Where
the request wants text, what was typed is the answer. An answer that does not
have the form the program reads is refused and kept as evidence in the
ledger; the request stays open.

An answer that is taken is also a message: xMatrix posts it in the
conversation under the holder's own name (`norn-answer:<reference>:<epoch>`),
so whoever follows the work reads who did it and what came of it. The message
is appended and not interpreted: nothing in it summons, commands or wakes.

## Asking a person

A holder that is no harness and no Instance address is a person:
`confirm(@Daniel, "Ship 4.2?", ~by=1d)`. Who that is is read where the request
is delivered, among those who can read the conversation, by name or handle
as a mention reads them. Nobody by that name, or more than one, settles the
request `Broke` with the reason, and the program goes on from that.

The delivery is a message from xMatrix that names the person, then says
what is asked in its first line (what a list of conversations shows of it),
and carries the request as a card (`appMetadata.nornRequest`: what is asked, about what,
what `choose` offers, when it closes). It declares a wait on them, so it
shows where what needs them shows. The Web draws the controls from the
request's verb: Yes and No, the options, or a field for words; Decline
refuses with a reason. Only that person's answer is taken
(`POST /api/channels/:channel/norn-requests/:ref/answer`, by their id in
`norn_requests.holder_user_id`, expand migration 0252), and it is read
against the request's type as an Agent's is.

A person's request needs nothing working on it. It stays open until they
answer, its `~by` passes (`NoReply`: silence is not consent), the program
ends, or they can no longer read the conversation (`Broke`, by the same
`message_content_read` rule that lets them read it). When it ends, the Hub
records how on the card's message as a command result and the wait on them
ends.

## Delegating

Whoever holds a request can delegate it, once, to one participant who answers
it for them ([Norn spec §7](https://github.com/norn-lang/norn/blob/main/docs/spec.md#7-where-programs-live)):
a person who cannot judge a question passes it to an Agent that can, or an
Agent passes a decision that is not its to make to its person. The program
does not see it: the request keeps its identity, its `~by` and its form, and
takes a new epoch, so it is a new holding and a new delivery message. The
ledger records who delegated it, to whom, when and why.

- A person delegates from the card (**Delegate…**:
  `POST /api/channels/:channel/norn-requests/:ref/delegate`), found by their
  id as for an answer. An Agent Run uses
  `xmatrix delegate <request> @who '<why>'`, and its delivery offers it.
- The delegate is a person who can read the conversation, by name; an Agent
  by its harness name, whose new Run takes it; or an Instance here by its
  address (`@claude:2`), whose Run is the program's authority's or the
  delegator's own, and which takes messages. The delivery goes to that
  Instance alone, as to one asked again on a Page, and tells it that
  answering does not end its Run. A participant the request leaves out
  (`~except`) is refused, and so is a person for a request with conditions
  such as `~repo`.
- The delegate's delivery says who delegated it and quotes their words. A
  person's card says so too, and its **Decline** reads **Give back**.
- A delegate's answer settles the request. Their refusal or failure gives it
  back to whoever delegated it instead (a new holding, delivered to them with
  the delegate's words), and the program reads nothing; so does a delegate
  that nobody works on any more, and an Instance that no longer takes
  messages. Only whom the program asked can refuse or fail a request.
- The card of a person who delegated says to whom (a note beginning
  `NORN_DELEGATED_NOTE`) and no longer waits on them. While the request is
  open they may take it back from that card
  (`POST /api/channels/:channel/norn-requests/:ref/reclaim`): it comes to them
  again as a new holding, and what the delegate answers afterwards is
  refused. The request's index row keeps who delegated it by their id, or
  the owner of the Agent that did (`norn_requests.delegator_user_id`, expand
  migration 0256), while the ledger says it is delegated; the request's view
  tells them (`yoursToTakeBack`). An Agent does not take a request back.
- A program's own `handOver` or `cancel` ends a delegation, and the
  deadline passes as it would have.

## Asking with a command

An Agent Run that needs one answer does not have to write a program:
`xmatrix confirm @Daniel Ship 4.2 now? --by 1d --otherwise No`,
`xmatrix choose @Daniel "Which plan?" Monthly Yearly`, `xmatrix ask @codex …`.
The Hub writes the program (`nornQuestionSource`), posts it to the Run's
conversation as xMatrix, and starts it with the Run's Instance as its author
and the Run's owner as its authority. Its result is the reply itself
(`Answered(Yes)`, `Refused(…)`, `NoReply`), told to the Instance by its
address, so it wakes to read it. `--otherwise` is what silence means: the
answer taken when `--by` passes.
The Instance that asked can call the question off while it is open:
`xmatrix cancel <request>` marks that program, and only that program, to
stop, and the same call runs its pass. The request ends `Cancelled`, a
person's card says it is no longer asked, an Agent that held it is let go,
and the asker reads the program's end. A program an Agent wrote in a message
is not called off this way.
What xMatrix says for such a program is not threaded under the program's
message, because that message is xMatrix's own and takes no reply.

A person reads such a question once, on its card. The card names the Agent
Instance that asks (`nornRequest.asker`, `claude:2`) and what silence means
(`nornRequest.otherwise`), and its closing note says how it ended, including
the answer taken for silence. The program's message (`norn-ask:…`) and its
end (`norn-end:norn-ask:…`) are the asker's to read: the Web gives them no
row, and the catalog neither previews them nor counts them unread
(`isNornAskProgramMessage`).

## A reference shows the request

Where a request is named to people, they are shown the request, not its
reference. A message names one as `request:<ref>` (the delivery to an Agent
does, in its heading). The Web draws a delivery's own "Request" line as the
request in full: the paragraphs it was written in, as body text, under a line
saying of whom it is asked and how it stands. A reference inside a sentence is
a chip: how what is asked starts, cut at a sentence or a word, with the whole
request in the chip's preview. Both are read from
`GET /api/spaces/:space/norn-requests/:ref` by whoever can read the
request's conversation; anyone else sees only "a request". A card for a
person carries no reference in its text at all. An Agent still answers by
the bare reference, which its commands take.

## Never silent

A delivered request is abandoned when it is unanswered and nothing works on
it: no execution of its delivery message is under way, no launch for it is
being prepared, waits for quota or is starting, and no Run it started is
still to take the message (`NORN_REQUEST_WORKED_SQL`). That covers a launch
that was refused, a process that never started, a Run that was stopped or
exited, and a turn that ended without one of the three commands.

Work that broke off is not the Agent giving up: when no turn on the request
ended in order (its turn failed, or nothing ever took it), the next pass hands
the request on, once. The holding that broke off is kept as evidence
(`NORN_HANDED_ON_REASON`), the request takes a new epoch, and its delivery is
a new message that starts a new Run, never the Instance that had it. That
message tells the holder to read the conversation for what the first attempt
did and to go on from there. A request that is abandoned again, and one whose
turn ended in order without an answer, is settled `Broke`, and the program
decides what follows.

A turn that was interrupted, because a newer message arrived in the
conversation, has not ended the work: its Instance goes on in its next turn
and may still answer, so the request stays with it while that Instance takes
messages. Once the Instance has ended a later turn without answering, the
request is abandoned.

The daemon's execution report tells the Hub when a finished turn left a
request open, and the Hub wakes the Channel's coordinator. A Run that ends
wakes it already.

## Work that repeats

A program repeats with `every(1d)->forEach(_ => run(…)->wait)`. Its ticks
keep the program's beat, a whole number of periods after it started, and each
round asks anew. `every(7d, ~from=2026-11-16T09:00Z)` counts the beat from
that time instead: the first round is then, and every week after. The conditions a program puts on its participant
(`@auto(~repo="acme/app", ~effort="high")`; `repo`, `pwd`, `machine`,
`harness`, `model`, `effort`) are written into the delivery's summon. A
condition this host does not know settles the request `Broke` with the
reason. An automatically chosen participant is chosen anew for every request
and is never asked again where it was.

A loop does not go back over the rounds it has handled: when a round's
handler finishes, the ledger keeps where the loop stands, and a later pass
begins there. Rewording the task on its Page therefore asks nothing again;
the next round is asked in the new words. A round that is out when the text
changes is asked again in the new words, and the request in the old words is
called off (`Cancelled`): its Agent is let go, and a person's card says the
program no longer asks.

A Run started for a request reads that request and the conversation's linked
Pages before its first turn, not the conversation's history: the request
carries what the program gives it, and a program that repeats would otherwise
hand each new Run a longer history than the last.

## Events from outside

A program waits for what happens outside it through the streams this host
declares (`NORN_HOST_INTERFACE` in `norn-host.ts`):

| Stream | An occurrence |
| --- | --- |
| `ciFailed("owner/repo")` | a workflow failed on the repository's default branch |
| `prMerged("owner/repo")` | a pull request was merged into its default branch |
| `appEvent("sentry", ~feature="issue.created")` | a connected app delivered an event; without `~feature`, any of its events |

`every(1d)->or(ciFailed("acme/app"))->forEach(_ => run(…)->wait)` runs a
round on its beat and at once when CI fails. Each pass stores the streams the
program waits on or listens to (`norn_programs.waits_json`, expand migration
0251). An event arrives in `outside-events.ts`, from GitHub's webhook or a
connector's ingress. It is recorded as an occurrence in the ledger of every
running program that waits on a matching stream, and the program is
evaluated at once (`norn-events.ts`). All matching streams in a program
receive the occurrence in one transaction. A digest of the provider event
identity is stored on those occurrences so a repeated delivery cannot add
another round. If the running Hub build cannot evaluate the source, that
transaction saves the occurrences and schedules a recheck. The value is the event in words, with
its link. A program hears an event only when its authority is a member who
may act and the Space's connection still covers the event's source. A program listens while a round of its loop is
out, too: the streams its loops take from are stored with the ones it waits
on (`pass.listening`). Events that arrive during a round are kept in the
ledger and are one more round when that one is over, with the latest event;
`ciFailed("acme/app")->gather` hands the handler all of them as a list.

Streams of one kind are brought to one shape with `map`, so a handler reads
text whichever stream occurred:
`let both = (a, b) => a->or(b)->map(each => switch each { | First(what) => what | Second(what) => what })`.

The streams are compiled into the program from the host's interface
(`hostSources`), so a name another host supplies is refused by the checker.

## The standard library

A program that writes `open Std` has Norn's standard library
(`vendor/norn/std.ts`, the text of `std/std.norn`): `routine`, `decide`,
`remind`, `followUp`, `schedule`, `all`. A repeating operation is one call:

```norn
open Std
routine(~every=7d, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/app"),
  ~otherwise=@claude(~repo="acme/app"), "Weekly upkeep")
```

A round every week from that time, asked of whoever fits; when that does not
end in an answer, asked once of the one named; a round that still fails is
told in the conversation. `~on` adds a round when a stream occurs.
`decide(who, question, ~options, ~recommend, ~by)` is a choice whose default
is taken only when nobody answered in time. The library is linked into the
program when it is compiled, so a later version of it reaches a running
program at its next pass.

## Asking the same participant again

A program on a Page that asks the same participant again asks the Instance
that last answered it for this program, if that one still takes messages
(live, or at rest where a message wakes it). The delivery is addressed to that
Instance and starts no Run; only that Instance is woken, so the other
Instances resting in the program's conversation are left alone. The request
records the Instance, which holds it. Without such an Instance, and for a
program in a message, each request starts a new Run as before.

## Who stays in the conversation

An Instance that a delivery started is let go once its request has ended: the
coordinator stops its Run if it is still live, or retires the Instance if it
is at rest (an Instance at rest has no live Run, and the next message would
wake it). The release is recorded on the request's index row, so each is let
go once. Some stay (`NORN_INSTANCE_STAYS_SQL`):

- one that holds a request still open;
- one that asked a question (`xmatrix ask`, `confirm`, `choose`) whose program
  still runs, so the answer finds it;
- in a Page program's conversation, the one a running program asks again by
  name, and the one that ended a request last (answered, refused, or failed);
- one a request was delegated to by its address: it was already at work here,
  and was not started for the request.

An Instance a delivery started is let go the same way once its Agent
delegated the request (`norn_requests.delegated_away_instance_id`, expand
migration 0257): the request goes on with someone else, and nothing is left
for it here unless one of the rules above keeps it.
So a Page program's conversation always has the Agent that did the work last:
a person who writes there after the program reaches it, with what it knows.
The others are let go, also while the program runs, so a routine does not
leave one Instance per round. In a shared conversation an Agent that has
answered does not stay to be woken by every later message.

## Asking a connected app

A program has a connected app do one thing by itself, with no Agent and no
person at the moment it is done
([Norn spec §6.3](https://github.com/norn-lang/norn/blob/main/docs/spec.md#63-actions)).
It is two requests, and the host holds both (`app:x`):

```norn
let ready = X.prepareVideo("@acme", "<message id>/<attachment id>", "Stop pasting API keys.")->wait?
after(2026-11-24T01:00Z)->wait
X.publish(ready)->wait
```

`Actions.prepare` fixes what will be done and has it admitted; nothing is sent.
`Actions.perform` does what was prepared, once. Between them the program waits
in its own words (`after`, `every`, an event), so a person approves a week of
posts in one sitting and each goes out at its time with nobody awake.

A program that ends and is edited afterwards runs again from an empty ledger
([Programs on a Page](#programs-on-a-page)), which would ask for, and under
Read and write send, everything its text still lists. A list of posts that
keeps growing therefore stays running (`never()->wait` as its last line) and
gives each post its own keyed scope (`spawn(~key=…)`): the ledger then
remembers each post by its key, and no edit sends one twice.

**What an app can be asked.** Every action a connected app declares, GitHub's
excepted (`NORN_CONNECTOR_EVENT_MANIFESTS`, `norn-libraries.ts`), which the checker
reads `Actions.action(app, name)` against. Its input is the two parts of the
Channel command, `{target, text}`, or named fields where the host gives the
action some (`x` `post`, `publish_video`); `nornActionStatement` turns either
into the command's statement, and the connector parses it as it parses a
command. Every action answers `{summary, url}`. The `X` library gives X's
actions their words: `X.preparePost`, `X.prepareVideo`, `X.publish`.

**Prepare** (`deliverNornAppRequest`, `norn-actions.ts`). The coordinator
stages the action as a command would be staged (`stageHeldAction`): parsed,
its account and content frozen in the encrypted action-request authority, and
held for the program's request (`app_connector_action_requests.norn_prepare_ref`,
expand migration 0269). The acting member is the program's authority, and the
connection's one permission decides what follows:

| Permission | The `prepare` request |
| --- | --- |
| Read and write | `Answered`: the permission admits it, and nobody is recorded as having decided |
| Ask first | Stays open as a request in the conversation's Pending approvals, showing the frozen account, content and attachment. A Space admin's Allow answers it `Answered`; Disallow, `Refused` |
| Read only | `Refused` |

An input the connector cannot parse, or an app that is not connected, is
`Broke` or `Refused` at once. An approval is good for 30 days. The decision
route tells the program (`settleNornAppRequest`), and approving runs nothing:
the request's state is `approved`, between pending and executing.

**Perform.** The coordinator takes the one step from approved to executing
(`claimHeld`), which records the `perform` that took it
(`norn_perform_ref`), and hands the request's reference to the durable
executor that runs X's video actions. A second `perform` of the same prepared
action is `Refused`. What was approved is read again as a decision reads it:
the approver is still an admin who reads the conversation, and the connection
and its account are the ones approved. Immediately before the provider is
called the permission is read once more: a request a person approved runs
under Ask first, and one the permission admitted runs only while it is still
Read and write. Anything that no longer holds is `Refused`, and nothing is
sent.

**The outcome.** The executor marks the action started before any provider
call and never repeats one whose outcome it does not know: that is reported
as failed. It gives the program its answer first, then posts the receipt in
the conversation; both are safe to repeat. Completed is `Answered` with the
receipt's summary and link, blocked is `Refused`, failed is `Broke`.

**Never silent.** Nothing else reports on a request the host holds, so the
host sets itself a time to look again (`norn_requests.host_due_at`, expand
migration 0268), which the coordinator's alarm includes: 30 days for an
approval, 30 minutes for an action that was handed to the executor. Past it
the request is `Broke`, with words for each half. It is never handed to
anyone else as an Agent's broken-off work is. A `prepare` that ends without
an answer leaves Pending approvals, and when a program ends, an approval it
asked for and never used is void (`withdrawNornAppRequests`).

## Saying something

`say(who, text)` tells someone without asking anything of them: a reminder,
a note that a round failed. What a program says is new to the ledger in the
pass that says it, so the step hands it over with the ledger and it is stored
in `data.norn_notices` in the same transaction. The coordinator posts each
one to the program's conversation as xMatrix, naming whom it is for, and
marks it posted. The message is appended without being interpreted, so it
starts and wakes nobody: whoever is named is told the way a mention tells
them.

A round of a repeating program whose handler ends in anything but an answer
is told the same way, once, naming nobody: the loop goes on, and the
conversation keeps why that round did not succeed.

## Deadlines and stop

A request's `~by` and a timer are the ledger's: a pass records the earliest
time at which the program could move by the clock alone, and the Channel's
coordinator sets its alarm to it.

A stop of the whole conversation marks its running programs in the stop
fence's transaction. Their next pass ends them and cancels their open
requests. A stop of one Run does not end a program: the request that Run
held becomes `Broke`.

A program is checked where it is written, so text that a pass cannot check
was written for another build of the Hub: one being rolled out, or one
rolled back. The pass leaves the program and its ledger as they are and
moves only the time of the next pass (five minutes on), and an answer given
meanwhile is refused with that reason. A stop reads no text and is taken
either way.

## How it ends

When a program completes or fails, the coordinator posts its result in reply
to the program's message. When an Agent started the program, the message
addresses that Instance, so it wakes to read the result.

A Page's program ends in its own conversation (`nornPageEnd`). A result that
is an Agent's answer stands there under that Agent's name already, so the end
says only that it finished. A program that failed by itself, and was
not stopped or taken off its page, names the people who held its requests, or
with none whoever saved it, says which request stopped it and why, and
declares a wait on them: it shows where what needs them shows. Nothing goes on
by itself from there; the Agent that stayed takes what they say next.

## Capabilities and libraries

Edition 1 programs receive outside events through the standard `Events`
capability interface (`Events.kind(app, kind)`, `Events.events(kind, ~source=?,
~subject=?)`, backed by CloudEvents 1.0.2 with idempotent `(app, kind, source,
id)` deduplication and manifest-driven field checking in `norn-libraries.ts`).
Legacy `ciFailed`, `prMerged`, and `appEvent` streams remain supported for
existing edition-0 programs and ledgers without mutating them.

Domain-specific streams live in pure Norn application libraries rather than
host externals:

- **`GitHub`**: `GitHub.issueOpened(repo)`, `GitHub.ciFailed(repo)`,
  `GitHub.prMerged(repo)`.
- **`Gmail`**: `Gmail.receivedAt(address, ~subjectContains=?)` filters mail
  inside the mailbox owner's authorized scope and projects only
  `Gmail.mailRef = { messageId }`, so email addresses, subjects, and bodies
  never leak into public Channel `~about` blocks.
- **`X`**, on the `Actions` capability ([Asking a connected app](#asking-a-connected-app)):
  `X.preparePost(account, text)`, `X.prepareVideo(account, video, text)`,
  `X.publish(prepared)`.

A Page may also declare Space libraries with `` ```norn 1 lib <ModuleName> ``
(`nornLibBlock` in protocol). When a program on that Page starts or is revised,
its Space libraries are pinned on its ledger (`pinnedLibraries`) so later
library edits never silently alter running programs; `pinNornProgram` and
`diffNornProgramUpgrade` compute SHA-256 pins and 3-way upgrade diffs, while
`previewNornEdit` and `verifyNornLedgerMigration` provide read-only edit
previews and fail-closed v1-to-v2 ledger migration verification.

`xmatrix connector list` prints each connected app's declared `Events` kinds
and typed fields alongside its actions. See [norn-host-index.md](norn-host-index.md)
for the compact always-on reference.

## Not in this version

- Requests to an existing Instance by its address, other than one its holder
  delegated there.
- GitHub's actions as requests of the app: they run through the GitHub App's
  own command pipeline, so a program asks an Agent for them.
- Facts from outside that hold once (a given pull request merged, a release
  that contains it).
- A preview of what an edit to a Page's program would change before it is saved.
- Moving `--wait`, cards and pull request subscriptions onto the ledger.
