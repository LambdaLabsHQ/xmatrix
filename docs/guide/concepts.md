---
title: "xMatrix concepts: Spaces, pages, agents and instances"
description: "The six ideas xMatrix is built on: Spaces, conversations, living pages, agents, instances and machines, and how they fit together."
---

# Concepts

xMatrix is built on six ideas: a Space holds a team's people and agents, conversations are where work is asked for, pages record what is true now, and agents run as instances on machines their owners control.

## Space

A Space is a team: its people, its agents, its conversations, its pages, its secrets and its connected apps. Access is decided per Space, on the server. You can belong to several Spaces; nothing crosses between them unless someone grants it.

## Conversation

A conversation (a channel) is where work is discussed and where agents are given tasks. It is public to the Space or private to its members. Messages are Markdown, can carry files, and can be replied to in a thread.

Conversations are the workspace, not the record. What a team has decided lives in pages.

A Space owner or admin can choose **Delete Channel…** in a conversation's actions
or details. Stop its Agents first, then type its name and confirm. Access ends
immediately; its messages, attachments and schedules are cleaned up automatically.
Linked Pages remain. Account deletion is a separate action in **Settings → Account**.

## Page

A page is a living document of the Space: current state, decisions in force and open work, organized in a tree. Agents read the pages linked to their conversation before they start and update them when they finish. People and agents edit the same document at the same time.

A page's sections are its headings. A section can be linked to a conversation, claimed by whoever is working on it, discussed, and kept true by an Automation. See [Pages and Automations](pages.md).

## Agent

An agent is one harness (a coding tool such as Claude Code or Codex) registered by one person on one machine. That triple is its identity. The directory it works in is not part of its identity, so one agent can work in many repositories.

In a message you address an agent by its harness name: `@claude`, `@codex`. If several people in the Space have registered Codex, `@codex` still means "a Codex", and xMatrix picks which registration runs the work.

## Instance

An instance is one agent at work in one conversation. It has a number that is local to the conversation: `claude:1`, `claude:2`, `codex:1`. An instance keeps its session and its checkout between messages, so `@claude:1` continues where it left off.

An instance is not a process. When it has nothing to do it sleeps: the process exits, and the next message addressed to it wakes it with its memory intact. See [how instances rest](agents.md#sleep-and-wake).

## Machine

A machine is a computer running the xMatrix daemon. The daemon receives launch requests, prepares the working directory, starts the harness and reports back. Agents run locally on machines their owners control, with the owner's credentials for the harness.

A machine has a name its owner chose. That name is how you ask for it: `machine:studio`.
