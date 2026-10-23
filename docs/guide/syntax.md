---
title: "@mention syntax for AI coding agents · xMatrix Docs"
description: "Full reference for xMatrix messages: start Claude Code or Codex with an @mention, pick the repo, model and effort, then stop, restart or hand off agents."
---

# Message syntax

Everything you ask of xMatrix is an ordinary message. There are no hidden forms: what you type is what is stored, and the server reads the same text you see. The composer completes all of it when you type `@`, `#` or `[[`, so you rarely need to write it from memory. This page is the full reference.

## At a glance

| You type | What happens |
| --- | --- |
| `@claude fix the failing test` | Start a new Claude instance and give it the message |
| `@auto repo:acme/api fix the failing test` | Let xMatrix pick the agent; start it in a worktree of `acme/api` |
| `@codex pwd:"/Users/me/my app" …` | Start in a registered directory, in place |
| `@codex model:<id> effort:high …` | Start with a specific model and reasoning effort |
| `@claude:2 also update the changelog` | Continue with instance 2 of Claude in this conversation |
| `@claude:2 /model <id>` | Switch a live instance's model |
| `@claude:2:stop` | Stop that instance |
| `@claude:2:reborn` | Restart it with its memory |
| `@claude:2:handoff:@codex finish the migration` | Move its checkout to a new Codex instance |
| `/stop all` | Stop every instance in the conversation |
| `@Maya` · `@everyone` | Notify a person, or everyone in the conversation |
| `@github:subscribe:acme/web pulls checks` | Run a connected app's action |
| `page:<id>` · `channel:<id>` | Refer to a page or a conversation |

## Mentions

A mention is `@` followed by a name. It counts when the `@` is at the start of the message or follows a space or an opening bracket. The full-width `＠` works the same as `@`.

Names are matched case-insensitively and the longest matching name wins, so `@codex-mba` is never read as `@codex`.

A mention that starts or commands an agent is a word of its own: put a space, a line break or closing punctuation after it. A mention that only notifies a person can sit directly against Chinese or Japanese text, as in `@Maya的方案`.

### What is not a mention

A mention inside any of these is plain text. It notifies nobody and starts nothing:

- inline code and code blocks
- block quotes
- links and images
- struck-through text

That is how you write about the syntax without triggering it: put the example in backticks.

### People

Type `@` and pick a person. The mention is their display name (`@Maya Chen`) or their handle. A mentioned person is notified, and the mention clears once they have read it.

`@everyone`, `@channel`, `@all` and `@here` notify every member of the conversation.

If two people share a name, or a person's name collides with an agent's, the message is refused until you pick the person by their handle.

## Starting an agent

A mention of a harness name starts a **new** instance of that agent in the conversation:

```text
@claude rework the hero so it shows the product
@codex check the mobile breakpoints
@auto find out why billing webhooks retry twice
```

- `@<harness>` asks for that harness: `@claude`, `@codex`, `@cursor`, `@gemini` and so on. See [supported harnesses](agents.md#supported-harnesses).
- `@auto` lets xMatrix choose. It reads the task and picks the harness that suits it, on the machine with the most headroom.

The rest of the message is the task. The agent also receives the conversation around it, so a short message such as `@claude take this one` is enough when the discussion above says what "this" is.

### Launch conditions

Conditions narrow where and how the agent starts. They are `key:value` words written directly after the mention, separated by spaces:

```text
@auto repo:acme/api model:<id> effort:high find out why webhooks retry twice
```

Here `@auto` is the mention, the three words after it are conditions, and everything from `find` on is the task.

| Condition | Meaning |
| --- | --- |
| `repo:<owner/repo>` | Work in a fresh managed worktree of this repository |
| `pwd:"<absolute path>"` | Work in this registered directory, in place |
| `machine:<name>` | Run on this machine, by the name its owner gave it |
| `harness:<name>` | With `@auto`: restrict the choice to one harness |
| `model:<id>` | Use this model |
| `effort:<level>` | Use this reasoning effort |
| `fast:on` | Turn on the harness's fast mode, when it offers one |
| `param.<id>:<value>` | Set any other option the harness advertises |
| `launch:force` | Start even if xMatrix read the mention as not asking for work |

The rules:

- **Conditions end at the first word that is not one.** Everything from that word on is the task. An unknown `key:value` is therefore just text, not an error.
- **Order does not matter**, and each condition appears at most once.
- **They stay on the mention's line.** A line break ends the conditions.
- **Quote a value that contains spaces** with double quotes. A literal quote inside is doubled: `pwd:"/Users/me/my ""old"" app"`.
- **A condition that cannot be met stops the launch.** xMatrix does not quietly substitute another model or machine. The mention shows why nothing started.

### Where the agent works

`repo:` and `pwd:` are alternatives; a mention can carry one of them.

**`repo:`** names a repository. The agent gets its own worktree, so several agents can work on the same repository at once without overwriting each other. Write GitHub repositories as `owner/repo`. A full HTTPS or SSH remote also works, and a GitHub remote is shortened to `owner/repo` for you. Credentials, query strings and fragments are never accepted in a reference.

```text
@codex repo:acme/web …
@codex repo:https://gitlab.example.com/team/service …
```

**`pwd:`** names a directory that someone registered on a machine with `xmatrix workspace register`. The agent works there in place, with whatever is checked out. The path must be absolute, and it selects that machine.

```text
@claude pwd:/srv/app …
@claude pwd:"C:\Users\me\my app" …
```

With neither, xMatrix chooses from the repositories and directories the Space has, by matching the task to their names and descriptions. Name the repository yourself when it is not obvious from the conversation.

### Model, effort and other options

`model:` and `effort:` take the ids the harness reports. The composer lists them after you pick a harness; the [Agents view](agents.md) shows them too.

Options beyond model and effort differ by harness, so they are not fixed keywords. Each harness advertises its own, and you set one with `param.<id>:<value>`:

```text
@kimi param.<id>:<value> summarize the incident
@codex fast:on apply the rename
```

The composer lists the ids and values a harness currently advertises. `fast:on` is short for `param.fast:on`. A switch accepts `on`, `off`, `true` or `false`.

### When xMatrix reads a mention as not a request

People mention agents without wanting one started: "the diff `@codex` produced yesterday", or an example in a write-up. xMatrix reads each launch mention in context, and when it reads one as a reference, an explanation or an example, it starts nothing and says so on the mention.

If you did mean it, add `launch:force`:

```text
@codex launch:force
```

### The first message of a new conversation

When the first message of a new conversation mentions nobody, you get a few seconds to choose which agent should pick it up, or none. If you do not choose, xMatrix reads the message and starts an agent only when it asks for work.

Later messages that mention nobody start nothing. Instances already in the conversation receive them as context and decide for themselves whether to respond.

## Talking to an instance

Each instance has a number in its conversation, shown next to its name: `claude:1`, `codex:2`. Address it with `@<name>:<number>`:

```text
@claude:1 the tests still fail on Windows, take another look
```

The message goes to exactly that instance. If it is asleep, the message wakes it. The number belongs to the conversation: `claude:1` here and `claude:1` elsewhere are different instances.

A reply to an instance's message is addressed to it as well, without a mention.

Other instances in the conversation see the message as context. They do not act on a message addressed to someone else.

## Commands for a live instance

A message that addresses one instance and continues with `/` is a command for that instance rather than work:

| Command | Effect |
| --- | --- |
| `@claude:1 /model` | List the models this instance can use |
| `@claude:1 /model <id>` | Switch model |
| `@claude:1 /effort` | List the reasoning efforts it offers |
| `@claude:1 /effort <level>` | Switch reasoning effort (`/reasoning` is the same command) |
| `@claude:1 /config <id>` | Show one advertised option, its choices and current value |
| `@claude:1 /config <id> <value>` | Set it |
| `@claude:1 /fast on` · `off` · `status` | Fast mode; bare `/fast` toggles it |
| `@claude:1 /goal <condition>` | Give the instance a completion condition it works toward across turns |
| `@claude:1 /goal status` · `pause` · `resume` · `clear` | Inspect or control that goal |

A switch applies to the running session. The instance keeps its memory and its checkout, and you do not restart it.

`/model` and `/effort` must be the whole message. Several can go in one message, one per line:

```text
@claude:1 /model <id>
@codex:2 /effort high
```

If any other text is mixed in, the message is delivered as ordinary work instead, so a switch is never half-applied.

Harnesses also have slash commands of their own. The composer lists what a live instance supports after `@<name>:<number> /`, and passes them through.

## Stopping, restarting and handing off

Anyone who can act in a conversation can control the instances in it, and so can agents.

| You type | Effect |
| --- | --- |
| `@claude:1:stop` | Stop this instance. `:kill` is the same. |
| `@claude:1:stop wrong branch` | The same, with a reason that is shown with the stop |
| `/stop all` | Stop every instance in the conversation. `/kill all` is the same. |
| `/stop claude:1` | Another way to stop one instance |
| `@claude:1:reborn` | Restart the same instance, keeping its session and checkout |
| `@claude:1:handoff:@codex` | Give its work and conversation to a new Codex instance |
| `@claude:1:handoff:@auto` | The same, and xMatrix picks the successor |

**Stop** must be the whole message; anything after the command is the reason. A stopped instance does not wake on new messages. Only `:reborn` brings it back.

**Reborn** restarts the same instance: same number, same memory, same directory. Use it when an instance is stuck, has failed to wake, or was stopped. Text after the mention is delivered to the restarted instance.

**Handoff** stops the predecessor and starts a different instance, often another harness, exactly as a summon would: routing picks the machine and model among every registration with quota, on any machine. The work comes along: a repository checkout, uncommitted changes included, travels on a handoff branch; a registered directory is handed over where it is. So does the conversation, across harnesses and models: the predecessor's machine exports what it was asked, said and ran (the first request and the newest turns), and the successor reads it before continuing, as context rather than as its own session. Text after the mention is the successor's task:

```text
@claude:1:handoff:@codex you have the branch; finish the migration and open the PR
```

The successor is always new, so it is a name without a number. `@auto` leaves the harness to routing as well.

## Connected apps

An app connected to the Space is addressed like an agent, with an action:

```text
@<app>:<action>:<target> <text>
```

```text
@github:subscribe:acme/web pulls checks
@github:comment:acme/web:#42 Reproduced on main.
@sentry:resolve:<issue>
```

The command must begin the message, and one message carries one command. Lines after the first are part of its text. [Connected apps](connectors.md) lists the apps and their actions.

## References

| You type in the composer | Stored in the message as | Shown as |
| --- | --- | --- |
| `[[` then pick a page | `page:<page-id>` | A chip with the page's current title |
| `[[page#` then pick a section | `page:<page-id>#<heading-slug>` | A chip that opens that section |
| `#` then pick a conversation | `channel:<channel-id>` | A chip with the conversation's current name |

The id is the reference, so renaming a page or a conversation never breaks old messages. A reference grants nothing: a reader who cannot see the target gets no title and no link. Mentioning a page in a conversation links the page to it.

The same `page:<page-id>` and `channel:<channel-id>` written in a page's own text are shown as these chips too; the id shows again on the reference the caret is in.

`#` followed by a digit stays text, so `#3484` remains a pull request number. A Chinese input method can open the page list with `【【`.

## Limits

- A message body is at most 131,072 characters.
- A message carries at most 8 commands.
- An instance name, a machine name, a model id and an effort are at most 160 characters; a path or repository reference at most 4,000.

## When nothing starts

The mention itself shows what happened: waiting, working, replied, failed or stopped, with the reason. The usual causes:

| What the mention says | What to do |
| --- | --- |
| Read as naming the agent, not asking one to start | Add `launch:force` after the mention |
| No registered environment offers the requested model, effort or harness | Check the id against what the harness reports, or drop the condition |
| No registered environment is available on the requested machine | Check the machine's name and that its daemon is online |
| The requested directory is not authorized | Register it with `xmatrix workspace register` on that machine |
| The repository reference is invalid | Write it as `owner/repo`, without credentials |
| Every matching environment has used up its provider quota | Wait for the reset, or ask for another harness |
| Only machines kept out of automatic assignment can run this | Name one with `machine:<name>` |
| The `:new` and `:once` suffixes are retired | Write `@auto repo:owner/repo` instead of `@agent:new:owner/repo` |

`xmatrix diagnose <conversation>` prints the same record from the terminal.
