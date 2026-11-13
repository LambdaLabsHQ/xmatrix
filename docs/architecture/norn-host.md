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
The message is the program's identity: seen again, it starts nothing. People,
Agents and Automations start a program the same way, by sending the message.

The Hub checks the program when the message is committed. A program that does
not check starts nothing, and a reply under the message names the line and
column of each error. One that checks runs with its author's authority: the
person who wrote it, or the owner of the Agent Run that did.

## Programs on a Page

A Page is where a program lives; a message is the ad-hoc way to run one. Each
top-level `norn run` block of a Page is a program. The word after the tag
names it (`norn run review`); without one it is `main`. The Page and the name
are the program's identity, so editing the block's text changes the same
program. Two blocks with one name run nothing until one is renamed.

A saved revision is synced like the Page's schedule lines
(`syncPagePrograms`, from the Page session's commit, a new Page, and a
restored revision), as whoever wrote it:

- A new block that checks starts its program.
- A changed block revises its running program: the same ledger is evaluated
  against the new text, so what was already asked in the same words stays
  asked and nothing is asked twice. A change that does not check is not
  applied.
- A block changed after its program ended runs again.
- A removed block, or a removed Page, stops its program.

Each block has one conversation for its whole life, named for the Page and
the block and linked to the Page. Every run opens with xMatrix's message
carrying the program's text, and its requests and result follow in that
conversation. `GET /api/spaces/:space/pages/:page/programs` answers, for
whoever can read the Page, how each block stands: its state, why it does not
run as written, and each request with its holder, outcome, reply and times.
The Page draws that as the program's steps, joined under the block
(`page-program-chips.ts`).

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

## Delivering a request

This version delivers to a harness by its name (`@codex`, `@claude`, …) and
to `@auto`. Each delivery starts a new Run. A request to a person, or to an
Instance by its address, is settled `Broke` with that reason; cards for
people come later. A request offered to several with `anyOf` is taken for the
group by the first of them this host can reach.

The coordinator posts one message per holding, as xMatrix, in reply to the
program's message. Its id is `norn:<reference>:<epoch>`, so a repeat appends
nothing. Its first line is the holder's summon. Everything the program wrote
(the task, `~about`, `~context`) is quoted in fenced text, which never
summons or commands anyone. The message states the form the answer must have
and the three commands that end the request.

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

## Never silent

A delivered request is abandoned when it is unanswered and nothing works on
it: no execution of its delivery message is under way, no launch for it is
being prepared, waits for quota or is starting, and no Run it started is
still to take the message (`NORN_REQUEST_WORKED_SQL`). That covers a launch
that was refused, a process that never started, a Run that was stopped or
exited, and a turn that ended without one of the three commands. The next
pass settles the request `Broke`, and the program decides what follows.

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
round asks anew. The conditions a program puts on its participant
(`@auto(~repo="acme/app", ~effort="high")`; `repo`, `pwd`, `machine`,
`harness`, `model`, `effort`) are written into the delivery's summon. A
condition this host does not know settles the request `Broke` with the
reason. An automatically chosen participant is chosen anew for every request
and is never asked again where it was.

A Run started for a request reads that request and the conversation's linked
Pages before its first turn, not the conversation's history: the request
carries what the program gives it, and a program that repeats would otherwise
hand each new Run a longer history than the last.

## Asking the same participant again

A program on a Page that asks the same participant again asks the Instance
that last answered it for this program, if that one still takes messages
(live, or at rest where a message wakes it). The delivery is addressed to that
Instance and starts no Run; only that Instance is woken, so the other
Instances resting in the program's conversation are left alone. The request
records the Instance, which holds it. Without such an Instance, and for a
program in a message, each request starts a new Run as before.

## Letting the Run go

The Instance that a delivery started exists for that one request. Once the
request has ended, however it ended, the coordinator stops the Instance's Run
if it is still live, or retires the Instance if it is at rest (an Instance at
rest has no live Run, and the next message would wake it). It records the
release on the request's index row, so each is let go once. A Page's
program keeps its Instances while it runs, for its next request to the same
participant, and lets them go when it ends. An Agent that has answered therefore does not stay in the conversation
to be woken by every later message. The delivery message tells the holder
that its answer ends its Run.

## Saying something

`say(who, text)` tells someone without asking anything of them: a reminder,
a note that a round failed. What a program says is new to the ledger in the
pass that says it, so the step hands it over with the ledger and it is stored
in `data.norn_notices` in the same transaction. The coordinator posts each
one to the program's conversation as xMatrix, naming whom it is for, and
marks it posted. The message is appended without being interpreted, so it
starts and wakes nobody: whoever is named is told the way a mention tells
them.

## Deadlines and stop

A request's `~by` and a timer are the ledger's: a pass records the earliest
time at which the program could move by the clock alone, and the Channel's
coordinator sets its alarm to it.

A stop of the whole conversation marks its running programs in the stop
fence's transaction. Their next pass ends them and cancels their open
requests. A stop of one Run does not end a program: the request that Run
held becomes `Broke`.

## How it ends

When a program completes or fails, the coordinator posts its result in reply
to the program's message. When an Agent started the program, the message
addresses that Instance, so it wakes to read the result.

## Not in this version

- Requests to people, and to an existing Instance.
- Facts from outside (a merged pull request, a release) and the standard
  library: programs are checked against the built-ins alone.
- A preview of what an edit to a Page's program would change before it is saved.
- Moving `--wait`, cards, Automations and pull request subscriptions onto
  the ledger.
