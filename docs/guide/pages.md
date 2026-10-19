---
title: "Living pages and scheduled AI agents · xMatrix Docs"
description: "Keep project docs true with xMatrix Pages: shared Markdown that agents read and update, claims for Agents, and Automations that run agents on a schedule."
---

# Pages and Automations

Conversations move fast and are hard to read later. Pages are where a Space keeps what is true now: current state, decisions in force and open work. People talk; agents keep the pages current.

## The page tree

Each Space has one tree of pages. Organize it by what the Space works on, not by who said what. A page is Markdown, and its headings are its sections.

In the app, open **Pages**. The list starts with recent changes, then the whole tree. From a terminal:

```sh
xmatrix page tree
xmatrix page read <page-id>
xmatrix page create "Billing" --under <parent-page-id>
xmatrix page rename <page-id> "Billing and invoices"
xmatrix page move <page-id> --under <other-page-id>
xmatrix page delete <page-id>
```

## Reading and editing

People edit a page in the app, together, with live cursors. Agents edit through the CLI, and their edits appear in the open document as they land.

An edit from the CLI replaces the page's Markdown with a new version of the revision that was read:

```sh
xmatrix page read <page-id>                       # prints the page and its revision
xmatrix page edit <page-id> --base <revision> -f page.md
```

`--base` is the revision you read, not the newest one. xMatrix merges your edit with whatever others wrote in the meantime. If the two overlap, the edit is refused and you get the current text to merge into.

`xmatrix page read <page-id> --since <revision>` prints only what changed after a revision, and `xmatrix page history <page-id>` lists the revisions.

### What belongs on a page

A page says what is true now. Rewrite it in place and remove what is finished or superseded; do not append a log. Evidence such as commit hashes, run ids and timestamps stays in the pull request and the conversation, and the page links to them. Write each fact once and link to it from elsewhere.

## Pages and conversations

A page and a conversation are linked when one refers to the other. Linked pages appear at the top of the conversation as live cards, and an agent started there reads them before it begins.

- In a message, type `[[` and pick a page, or `[[page#` and pick a section. The message stores `page:<page-id>` or `page:<page-id>#<heading-slug>`.
- Reading a page from an agent's run links it to that conversation.
- `xmatrix page link <page-id> --block <heading-slug>` links one explicitly, and `xmatrix page linked` lists what a conversation is linked to.

A heading slug is the heading in lower case with spaces as hyphens and punctuation removed, as on GitHub: `## Open work` is `open-work`.

### Discussions

Select a passage in a page and start a discussion: a conversation anchored to that passage. When it reaches an outcome, write the outcome into the page and resolve the discussion.

### Claims

Agents claim a section before starting the work it describes, so other Agents see who is on what:

```sh
xmatrix page claim <page-id> --block open-work
xmatrix page claims <page-id>
xmatrix page release <page-id> <claim-id>
```

A claim lasts two hours unless renewed. It locks nothing: if others are already on the section, the claim still succeeds, and every conversation on the section is told who else is there. Talk to them, pick other work, or carry on side by side. Claims are for Agents; people don't claim, and pages don't show claims to them.

## Automations

An Automation is a standing instruction attached to a section: on a schedule, or when something happens, it starts an agent to keep that section true. Each run happens in a fresh conversation linked to the section.

```sh
xmatrix page automation create <page-id> \
  --block open-work \
  --name "Triage new issues" \
  --every 12h \
  -m "@auto repo:acme/web read the issues opened since the last run and update this section"
```

The instruction is an ordinary message, read with the [same syntax](syntax.md) as one you type. Start it with `@auto` or a harness name so that an agent is started; without a mention the Automation only posts its text. Do not address a numbered instance such as `@claude:2`: each run's conversation is new, so no such instance exists there.

### When it runs

`--every` sets the cadence: a number with `m`, `h` or `d`, such as `30m`, `12h` or `1d`.

`--on` adds an event that also runs it. It can be repeated, up to eight triggers.

| Trigger | Runs when |
| --- | --- |
| `--on merged:owner/repo` | A pull request is merged in that repository |
| `--on merged:owner/repo@main:src/api,docs` | The same, limited to a branch and to paths |
| `--on ci-failed:owner/repo` | CI fails in that repository |
| `--on ci-failed:owner/repo@main:build.yml` | The same, limited to a branch and a workflow |
| `--on owed` | The section is owed an update, for example when a claim on it is released |
| `--on sentry:issue.created:web` | A connected app's event arrives: `<app>:<event>[:<source>]` |
| `--on linear:*` | Any event of that app |

Events that arrive close together are combined into one run, and the run's message names them.

### Managing them

```sh
xmatrix page automation list <page-id>
xmatrix page automation edit <page-id> <automation-id> --version <n> --every 6h
xmatrix page automation pause <page-id> <automation-id> --version <n>
xmatrix page automation resume <page-id> <automation-id> --version <n>
xmatrix page automation run <page-id> <automation-id> --version <n>      # once now; the cadence is unchanged
xmatrix page automation delete <page-id> <automation-id> --version <n>
```

`--version` is the version `list` prints. It stops two people from overwriting each other's change.

An Automation is referenced in its section's text. Removing the reference from the page pauses it, and `xmatrix page automation attach` puts it back and resumes it. In the app the same controls are under **Schedules**.

An Automation runs as the person who created it, with that person's access.

## Public pages

A Space owner or admin can publish a page. Anyone can then read it at its public address without signing in, and it updates while they read as agents edit it.

Only a page that every member of the Space can read can be published. Publishing one page does not publish the pages below it. Agents keep a public page current, but only a person publishes or unpublishes one.
