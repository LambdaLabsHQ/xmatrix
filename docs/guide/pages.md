---
title: "Living pages and scheduled AI agents · xMatrix Docs"
description: "Keep project docs true with xMatrix Pages: shared Markdown that people and agents edit together, and Automations that run agents on a schedule."
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

People edit a page in the app, together, with live cursors. Agents edit through the CLI, and their edits appear in the open document as they land. Nothing is locked: each section shows who is in it and which agents are working in its conversations, and `xmatrix page read` tells an agent the same.

An edit from the CLI replaces the page's Markdown with a new version of the revision that was read:

```sh
xmatrix page read <page-id>                       # prints the page and its revision
xmatrix page edit <page-id> --base <revision> -f page.md
```

`--base` is the revision you read, not the newest one. xMatrix merges your edit with whatever others wrote in the meantime. If the two overlap, the edit is refused and you get the current text to merge into.

`xmatrix page read <page-id> --since <revision>` prints only what changed after a revision, and `xmatrix page history <page-id>` lists the revisions.

To see who wrote a passage in the app, rest the pointer on its paragraph: the margin shows who wrote it and when. Select a passage and a note over it says the same, with the conversation it was written in; clicking that opens the conversation beside the page, at the message it had reached when the passage was written. Text being typed that is not saved yet reads "being written".

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

## Automations

An Automation is a schedule written in a page: a standing instruction in the section it keeps true that, on a cadence, at a time, or when something happens, starts an agent to keep that section true. It is a line of the page, written the way [Obsidian Tasks](https://publish.obsidian.md/tasks/) writes a recurring or scheduled task, and you read and change it like any other text. Each run happens in a fresh conversation linked to the section.

```markdown
## Open work
- [ ] @auto repo:acme/web read the issues opened since the last run and update this section 🔁 every 12 hours
- [ ] Remind me to renew the domain ⏳ 2026-11-03 09:00 +08:00
```

The text before `🔁` or `⏳` is an ordinary message, read with the [same syntax](syntax.md) as one you type. Start it with `@auto` or a harness name so that an agent is started; without a mention the schedule only posts its text. Do not address a numbered instance such as `@claude:2`: each run's conversation is new, so no such instance exists there.

### When it runs

`🔁` sets the cadence: `every 30 minutes`, `every 12 hours`, `every day`, `every 2 weeks`, or short forms such as `every 12h`. It runs at most every 15 minutes and at least every 30 days.

After the cadence, `, on <event>` adds an event that also runs it, up to eight.

| After `🔁 every day` | Runs when |
| --- | --- |
| `, on merged:owner/repo` | A pull request is merged in that repository |
| `, on merged:owner/repo@main:src/api,docs` | The same, limited to a branch and to paths |
| `, on ci-failed:owner/repo` | CI fails in that repository |
| `, on ci-failed:owner/repo@main:build.yml` | The same, limited to a branch and a workflow |
| `, on sentry:issue.created:web` | A connected app's event arrives: `<app>:<event>[:<source>]` |
| `, on linear:*` | Any event of that app |

Events that arrive close together are combined into one run, and the run's message names them.

`⏳` with a date, a time and its offset runs it once, as a reminder that waits on you in Needs you. When it has run, its line is checked off: `- [x] … ✅ 2026-11-03`. With `🔁`, `⏳` sets when its first run happens.

### Changing them

Change the line. `- [-]` pauses a schedule and `- [ ]` resumes it; deleting the line deletes it. A line that cannot run as written, such as `every 3 months` or an event in a repository the Space's GitHub connection does not cover, shows why next to it, and `xmatrix page edit` prints it.

A schedule runs as the person who last changed its line, with that person's access; when an agent changes it, as the agent's owner.

```sh
xmatrix page automation list <page-id>
xmatrix page automation run <page-id> <automation-id>      # once now; the cadence is unchanged
xmatrix page automation pause|resume|delete <page-id> <automation-id>
```

In the app, the Space's schedules are listed under **Schedules**.

## Public pages

A Space owner or admin can publish a page. Anyone can then read it at its public address without signing in, and it updates while they read as agents edit it.

Only a page that every member of the Space can read can be published. Publishing one page does not publish the pages below it. Agents keep a public page current, but only a person publishes or unpublishes one.
