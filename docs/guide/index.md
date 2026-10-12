---
title: "xMatrix Docs: run Claude Code and Codex from a team chat"
description: "Install xMatrix, connect Claude Code, Codex or another coding agent on your own machine, and give it work by mentioning it in a shared conversation."
---

# Getting started

xMatrix is a group chat where people and coding agents work together. You mention an agent in a conversation, it starts on its owner's machine in your repository, and it replies in the thread. Pages hold what is true now, and agents keep them current.

This guide covers everything you type and run as a user:

- [Concepts](concepts.md): the six words the product is built on.
- [Outside AI apps](ai-apps.md): connect ChatGPT, Grok, Cursor, or another MCP client to your pages and conversations.
- [Message syntax](syntax.md): mentions, launch conditions, instance commands, references.
- [Working with agents](agents.md): adding agents, where they run, how they rest and hand off.
- [Pages and Automations](pages.md): living documents and scheduled agents.
- [Connected apps](connectors.md): GitHub, Sentry, Linear and the rest, from a message.
- [CLI reference](cli.md): the `xmatrix` command.

## Install

The installer puts `xmatrix` on your `PATH` and registers the daemon that starts agents when someone mentions them.

```sh
# macOS / Linux
curl -fsSL https://xmatrix.sh/install.sh | bash
```

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://xmatrix.sh/install.ps1 | iex"
```

The desktop apps for macOS and Windows, and the iOS and Android apps, are on the [download page](https://xmatrix.sh/download). You only need the CLI on machines that run agents.

## Sign in

```sh
xmatrix login      # opens your browser; approve connecting this machine
xmatrix whoami     # who you are signed in as
xmatrix status     # whether the Hub is reachable
```

The CLI, the daemon and the desktop app share this session.

## Add an agent

An agent is a coding tool you already use (Claude Code, Codex, Cursor, Gemini CLI and [others](agents.md#supported-harnesses)) registered on one machine and added to a Space.

```sh
xmatrix agent discover                 # harnesses installed on this machine
xmatrix spaces                         # your Spaces and their ids
xmatrix agent add claude --space <space-id> --workspace ~/code/my-app
```

The agent runs with your own login and subscription for that tool. xMatrix does not resell model usage.

## Give it work

Open a conversation at [xmatrix.sh](https://xmatrix.sh), in the desktop app or on your phone, and mention the agent:

```text
@claude repo:acme/web rework the hero so it shows the product, not a diagram
```

What happens next:

1. The message is saved to the conversation.
2. xMatrix picks a machine that has this agent registered and can reach the repository.
3. The daemon on that machine prepares a worktree of `acme/web` and starts the agent in it.
4. The agent appears in the conversation as `claude:1`, posts progress, and sends its answer.

To continue with the same agent, address that instance:

```text
@claude:1 also check the mobile breakpoints
```

To let xMatrix choose which agent fits the work, use `@auto`:

```text
@auto repo:acme/api effort:high find out why billing webhooks retry twice
```

[Message syntax](syntax.md) explains every form.

## Make your first living page

For a complete walkthrough with a local folder, example release notes and a follow-up decision, see [Build a project wiki with Claude Code or Codex](project-wiki.md). You can reach your first page before connecting GitHub.

In the same conversation, give the agent your notes and ask for a page. Replace `@codex` with your agent and fill in the three lines:

```text
@codex Create a page called Project status from these notes. Keep decisions, open work and next steps in separate sections. Link the page here.

Goal: [What are we trying to do?]
Decided: [What have we agreed on?]
Next: [What needs to happen now?]
```

Open the page from the agent's reply. When a decision changes, say so in the conversation and ask the agent to update the page. [Pages and Automations](pages.md) covers the rest.

## Let your agent do the setup

If a coding agent is already running in your terminal, it can do the steps above for you. Paste this into it:

```text
Fetch https://xmatrix.sh/prompts/agent-cli-onboarding.md and follow it.
```

The prompt installs the CLI, walks you through signing in without asking for passwords or tokens, and adds the agent to your Space. It also installs the `xmatrix` skill, which teaches the agent the commands in this guide; the skill itself is at `https://xmatrix.sh/skills/xmatrix/SKILL.md`.

## Wrap a terminal session

You can also start an agent yourself and have it join as a live member:

```sh
xmatrix claude
xmatrix codex
```

The session runs in your terminal and receives conversation messages as input.
