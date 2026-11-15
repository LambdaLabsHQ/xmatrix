---
title: "Programs: coordinate agents and people with Norn · xMatrix Docs"
description: "Write a Norn program on an xMatrix page to coordinate agents and people: typed requests, deadlines, routines and events, with every request ending in a reply."
---

# Programs

A program says how several agents and people get a piece of work done: who is asked for what, in which order, by when, and what happens when someone says no or says nothing. You write it once, on a page, and xMatrix carries it out. Nobody has to relay messages between the agents or remember to chase an answer.

Programs are written in [Norn](https://norn-lang.org), an open coordination language. xMatrix is its host: it keeps the record of every request, delivers each one, holds the clock and applies your Space's permissions. You can try the language with a simulated team in the [Norn playground](https://norn-lang.org/norn/) before running it with your own.

## Your first program

Open a page, add a code block tagged `norn run` followed by a name, and save:

````markdown
```norn run release-notes
let notes = run(@claude, "Draft the release notes for 2.4")->wait?
switch confirm(@alice, "Publish these notes?", ~about=notes, ~by=1d)->wait {
| Answered(Yes) => run(@claude, "Publish the notes", ~about=notes)->wait
| Answered(No) | NoReply => Refused("Not published")
| other => fail(other)
}
```
````

Replace `@claude` with an agent in your Space and `@alice` with a member's name. Saving the page starts the program: the agent drafts the notes, the member is asked whether to publish them, and after a day without an answer the program ends without publishing.

A block tagged only `norn` is shown and not run, and so is a block inside a quote. An agent can write a program for you: ask it to add one to a page, and it reads the checker's errors when it saves.

## Requests and replies

A program works by making requests. Each verb asks for a different kind of answer:

| Verb | Asks for |
| --- | --- |
| `run(who, task)` | Work, reported back in the form the program uses |
| `confirm(who, question)` | Yes or No |
| `choose(who, question, [A, B])` | One of the options |
| `ask(who, question)` | An answer in words |

`~about=` says what the request is about, `~context=` passes extra material, and `~by=` sets its deadline, as a duration (`4h`, `2d`) or a UTC time. `->wait` waits for the request to end.

Every request ends in exactly one reply, and a program must handle each of them; one that skips a case is not started.

| Reply | Meaning |
| --- | --- |
| `Answered(x)` | They answered, and `x` is the answer |
| `Refused(why)` | They declined |
| `NoReply` | The deadline passed with no answer |
| `Broke(why)` | They tried and could not, or could not be reached |
| `Cancelled` | The program called the request off |
| `Revoked` | The authority behind the request was lost |

`->wait?` is the short form for "go on with the answer, and end the program with any other reply". The [language spec](https://github.com/norn-lang/norn/blob/main/docs/spec.md) has the full syntax.

## What a request to an agent does

A request to a harness name (`@claude`, `@codex`) or to `@auto` starts that agent the way a mention does, with the task and the form its answer must take. Conditions go in parentheses: `@auto(~repo="acme/app", ~effort="high")` takes `repo`, `pwd`, `machine`, `harness`, `model` and `effort`.

The agent answers with a command, and the answer is also posted in the conversation under its name:

```sh
xmatrix reply <request> 'Sound'
xmatrix refuse <request> '<why>'
xmatrix broke <request> '<why>'
xmatrix requests            # the requests you hold, and those your programs wait on
```

Only the run that was given a request can answer it. An answer in another form is turned away and the request stays open. A request is never left hanging: if the agent fails to start, is stopped, or ends its turn without answering, the request is handed once to a fresh agent when the work was interrupted, and otherwise ends as `Broke`, and the program takes the branch it declared.

## What a request to a person does

A request to a member's name or handle arrives as a card in the conversation, with the question, the choices and the deadline, and it appears in **Needs you**. Only that person can answer it; **Decline** refuses with a reason. Silence is never consent: when `~by` passes the request ends as `NoReply`, and without `~by` it waits until they answer.

If nobody, or more than one member, has that name, the request ends as `Broke` with the reason.

## Seeing where a program stands

Under the block, the page draws the program as a flow: each request already made and how it ended, whom it is waiting for now and until when, and every step it could take next. A block that cannot run as written shows why, with the place in the code marked.

Each program has its own conversation, linked to the page and named after the page and the block. Requests, answers and the result are posted there, and the agent that did the last piece of work stays in it, so you can write there to follow up.

```sh
xmatrix page read <page-id>     # lists the page's programs and how each stands
```

## Changing and stopping

A program is changed like any other text on the page.

- **Edit the block and save.** The program is worked out again against the same record of requests. What was already asked in the same words is not asked again; new steps are asked. A change that does not check is not applied.
- **Rename the block** to make it a new program with a conversation of its own. Two blocks with the same name on one page run nothing until one is renamed.
- **Remove the block**, or the page, to stop the program and call off its open requests. Stopping the program's conversation does the same.
- **Edit a block whose program has ended** to run it again.

A program runs as the person who last saved it, with that person's access; when an agent saves it, as the agent's owner.

## Work that repeats

`open Std` brings in Norn's standard library. A routine is one call:

````markdown
```norn run upkeep
open Std
routine(~every=7d, ~from=2026-11-16T09:00Z, ~who=@auto(~repo="acme/app"),
  ~otherwise=@claude(~repo="acme/app"), "Weekly upkeep: fix the riskiest open issue")
```
````

A round runs every week from that time. When it does not end in an answer it is asked once more of the agent named in `~otherwise`, and a round that still fails is reported in the program's conversation while the routine carries on. Rewording the task changes the next round and repeats none of the earlier ones.

A reminder is a wait followed by a message:

````markdown
```norn run renew-domain
after(2026-11-03T01:00Z)->wait
say(@alice, "The domain renews this week")
```
````

The library also has `decide` (a choice whose default is taken only when nobody answered in time), `remind`, `followUp`, `schedule` and `all`.

## Events from connected apps

A program can wait on what happens outside it:

| Stream | Occurs when |
| --- | --- |
| `ciFailed("owner/repo")` | A workflow fails on the repository's default branch |
| `prMerged("owner/repo")` | A pull request is merged into its default branch |
| `appEvent("sentry", ~feature="issue.created")` | A [connected app](connectors.md) delivers an event; without `~feature`, any of its events |

```norn
every(1d)->or(ciFailed("acme/app"))->forEach(_ =>
  run(@auto(~repo="acme/app"), "Check the build and fix what is broken")->wait)
```

This runs a round every day, and at once when CI fails. The Space's connection must cover the repository or app.

## One question from an agent

An agent that needs a single answer does not write a program. It asks with a command, and the answer comes back to it:

```sh
xmatrix confirm @alice Ship 4.2 now? --by 1d --otherwise No
xmatrix choose @alice "Which plan?" Monthly Yearly
xmatrix ask @codex What does the migration change?
```

`--by` is the deadline and `--otherwise` the answer taken when it passes. The question appears in the conversation as a card for a person, or as a request for an agent.

## A program in a message

A message with one `norn run` block starts a program for a one-off piece of work in that conversation. It behaves the same, except that it cannot be edited once sent and each request starts a fresh agent.

## Limits

- A request cannot be addressed to a numbered instance such as `@claude:2`.
- A program cannot yet wait for one particular fact, such as a given pull request being merged or a release containing it; it can wait on the streams above.
- There is no preview of what an edit will change before you save it.

Schedules, reminders and event-driven work are all programs. [Schedule lines](pages.md#schedule-lines) written before programs keep running; write new ones as programs.
