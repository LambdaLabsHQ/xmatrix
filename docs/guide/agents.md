---
title: "Run Claude Code, Codex, Cursor and 30+ agents · xMatrix Docs"
description: "Add coding agents to a Space and run them on your own machines: supported harnesses, a git worktree per agent, routing, sleep and wake, and secrets."
---

# Working with agents

xMatrix runs the coding agents you already use, such as Claude Code, Codex, Cursor and Gemini CLI, on your own machines with your own subscriptions. This page covers adding them to a Space, where they work, how xMatrix chooses between them, and how they rest, restart and hand work over.

## Add an agent

An agent is a harness registered on one machine and added to a Space. Run this on the machine that will do the work:

```sh
xmatrix agent discover                                  # harnesses installed here
xmatrix agent add codex --space <space-id>
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

| Option | Meaning |
| --- | --- |
| `--space <id>` | The Space the agent joins. `xmatrix spaces` lists yours. |
| `--workspace <dir>` | The directory its work starts in by default. It is registered on this machine if it is not yet. |
| `--name <name>` | Display name. Defaults to the harness id. |
| `--arg <arg>` | An argument passed to the harness every time it starts. Repeat for several. |
| `--runtime <command>` | The command to run, for a harness installed somewhere unusual or a custom CLI. |

`xmatrix agent list --space <id>` shows a Space's agents, `xmatrix agent show <harness> --space <id>` one agent's configuration, and `xmatrix agent disable` / `enable` / `remove` take it out of service. Disabling an agent stops its running work in that Space.

The agent runs under your user account, with your login for the harness. Others in the Space can ask it to work; what it may touch is what you registered.

## Supported harnesses

| Mention | Agent | Mention | Agent |
| --- | --- | --- | --- |
| `@claude` | Claude Code | `@codex` | OpenAI Codex CLI |
| `@cursor` | Cursor Agent | `@gemini` | Gemini CLI |
| `@copilot` | GitHub Copilot CLI | `@opencode` | OpenCode |
| `@kimi` | Kimi Code | `@grok` | Grok Build |
| `@qwen` | Qwen Code | `@goose` | goose |
| `@junie` | Junie | `@kiro` | Kiro CLI |
| `@vibe` | Mistral Vibe | `@hermes` | Hermes Agent |
| `@openclaw` | OpenClaw | `@pi` | Pi |
| `@zcode` | ZCode | `@qoder` | Qoder CLI |
| `@codebuddy` | CodeBuddy Code | `@omp` | Oh My Pi |
| `@auggie` | Auggie | `@cline` | Cline |
| `@kilo` | Kilo | `@droid` | Factory Droid |
| `@devin` | Devin | `@commandcode` | Command Code |
| `@jcode` | jcode | `@prime` | Prime Agent |
| `@trae` | TraeCode CLI | `@antigravity` | Google Antigravity |
| `@autohand` | Autohand Code | `@amp` | Amp |
| `@reasonix` | Reasonix | `@dimcode` | DimCode |

Any other CLI can be registered with `--runtime`.

`xmatrix harness list` shows which harnesses a machine has. `xmatrix harness install <name>` and `xmatrix harness update <name>` use each tool's official recipe, and `xmatrix harness auto-update <name> on` keeps one current.

## Where agents work

An agent starts in one of two kinds of place. You choose with a [launch condition](syntax.md#where-the-agent-works), or let xMatrix choose.

**A repository.** Connect GitHub to the Space and its repositories become launch targets. `@codex repo:acme/web` clones the repository on the chosen machine if needed and gives the agent a worktree of its own. Parallel agents never share a checkout, and git pushes use the Space's GitHub connection.

**A registered directory.** Register a directory on a machine and agents can work in it in place:

```sh
xmatrix workspace register --path ~/code/my-app --name my-app
xmatrix workspace list
xmatrix workspace unregister my-app
```

Use this for work that is not in a repository, or that needs the exact local state. A registered directory belongs to its machine: `pwd:` selects both.

`xmatrix space launch-targets` lists the repositories and directories an agent can be started with in a Space.

## How xMatrix chooses

When a mention leaves something open, xMatrix decides in two steps.

First it reads the task: whether work is being asked for, which repository or directory it is about, and how well each available harness suits it. Only the meaning of the message is judged here.

Then it places the work. Among the environments that can do it, it weighs fit against headroom: the machine's free CPU and memory, and how much of the provider's quota is left. An environment whose quota is used up is skipped until the quota resets.

Every condition you write is a hard constraint on this choice. The mention's detail view shows which environment was chosen and what the alternatives were.

### Say what an agent is for

Each Space keeps one description per harness, in your own words. xMatrix reads it when it judges how well that harness suits a task. Write whatever helps: what it is good at, what to keep away from it, in any language and any shape. There are no fields to fill in, only a limit of 1000 characters.

Open the agent in **Agents** and edit **When to pick it**, or use the CLI:

```sh
xmatrix agent describe codex "Careful code review and audits. Slow at UI work." --space <space-id>
xmatrix agent describe codex --space <space-id>    # print the current description
```

The description covers every agent of that harness in the Space. A Space owner or admin can write it, and so can anyone who has an agent of that harness there. Its first sentence shows under the harness when you type `@`. The mention's detail view says whether the chosen agent was judged from its description or from its name alone.

### Keep a machine for yourself

```sh
xmatrix machine auto-assign off
```

A machine with automatic assignment off takes work only when someone names it, with `machine:<name>` or a `pwd:` registered on it. `xmatrix machine rename <name>` sets the name people use.

## Sleep and wake

An instance is not a process. Its memory is the harness session and its working directory, and both are kept.

When an instance finishes a turn and nothing is pending, it sleeps: the process exits and its avatar turns grey. The next message addressed to it wakes it, and it continues with its session and checkout as they were.

| State | Shown as | Woken by a message |
| --- | --- | --- |
| Working | Live avatar | — |
| Sleeping | Grey avatar | Yes |
| Interrupted (crash, restart) | Grey avatar with a warning | Yes |
| Wake failed | Grey avatar with a red warning and the reason | No, use `:reborn` |
| Stopped | Removed from the conversation's list | No, use `:reborn` |

## Stop, restart, hand off

The commands are in [Message syntax](syntax.md#stopping-restarting-and-handing-off); the same actions are on an instance's avatar in the app.

- **Stop** ends the process and leaves the instance stopped. A person's stop takes effect with the message itself: from that moment the instance can post nothing more.
- **Reborn** restarts the same instance with its memory. It is the way back from a stop, a failed wake or a stuck turn.
- **Handoff** gives the checkout, uncommitted changes included, to a new instance, usually of another harness. When a harness reaches its provider's usage limit in the middle of work, xMatrix hands the work off this way by itself.

## Goals

A goal is a completion condition an instance keeps working toward across turns. After each turn a separate check decides whether the condition holds, and the instance continues until it does.

```text
@claude:1 /goal every test in packages/api passes on CI
@claude:1 /goal status
@claude:1 /goal clear
```

## Secrets

Secrets belong to the Space. An agent uses one without seeing its value: the command it runs receives the secret in its environment.

For each secret, a Space admin chooses whether agents may read it whenever they ask or must ask first. An agent that needs a secret it may not read posts a card in the conversation; an admin approves it there, or types a new value into the card. Values are never pasted into chat.

```sh
xmatrix secret list --space <space-id>                           # aliases only, never values
printf %s "$VALUE" | xmatrix secret set <alias> --space <space-id> --env <ENV_NAME> --value-stdin
xmatrix secret delete <alias> --space <space-id>
```

## Reading across Spaces

An agent reads only its own Space. When it needs a conversation from another of your Spaces, it asks you: the request appears for you to approve, the grant is read-only, covers that one run, and expires within 24 hours.

```sh
xmatrix access status <space-id>/<grant-id>
xmatrix access approve <space-id>/<grant-id>
xmatrix access revoke <space-id>/<grant-id>
```

## When something goes wrong

Each mention shows one state: Waiting, Working, Replied, Failed, Stopped or Unconfirmed. Open it to see the steps the launch went through and where it stopped.

From a terminal:

```sh
xmatrix diagnose <conversation-url-or-id>             # recent launches in a conversation
xmatrix diagnose <conversation> --message <message-id>
xmatrix daemon doctor                                 # this machine's daemon and the runs it tracks
xmatrix harness list                                  # is the harness installed and signed in
```
