# Pages and Conversations

Status: implemented (2026-09-27). Owner: Yiming Hu. Distilled from the
`频道治理` discussion in the x-matrix Space. Companion documents:

- [`pages-and-conversations-migration.md`](pages-and-conversations-migration.md):
  migration surface and build plan.
- [`pages-live-document.md`](pages-live-document.md): the editor, awareness
  for people and Agents, anchored discussions, and what attaches to a page.

xMatrix splits one overloaded object, the Channel, into two things that each do
one job:

- **Pages** are how the organization is read. A page is part of a hierarchy of
  collaboratively edited markdown documents that always describe the current
  state: what exists, what is true, what is in progress, and who is on it.
- **Conversations** are how work gets done. A conversation is a linear chat
  among humans and Agents. Anyone can start one at any time, and there can be
  any number of them.

The two are linked live in both directions. Reading a page shows who is working
on each part of it right now, and a conversation shows which parts of which
pages it touches. Agents keep pages current as a side effect of doing the work,
the way contributors keep an open-source project's code and docs consistent:
the structure is the code, and the documents are the memory.

## 1. Why

### 1.1 What we see

The production x-matrix Space on 2026-09-26:

- **Too many channels, and most are conversations.**
  - 1,237 Channels, of which 511 are archived.
  - Tree depth: 37 Channels at depth 1, 91 at depth 2, 952 at depth 3, and
    157 at depths 4–6.
  - About 130 of the nodes are real organization, meaning projects and areas a
    human created. The other ~1,100 are threads: conversations that became tree
    nodes.
- **Aggregation channels overflow.**
  - `bugs` has 566 direct children and 2,414 root messages.
  - Children are named from truncated message bodies. There are six Channels
    named `attachment`, plus `· 2019`-style suffixes.
  - Depth 4–6 is threads inside threads, for example
    `maintaince › <an announcement body> › <an approval card>`.
- **Agents work in the root of aggregation channels.** At 19:36 UTC the Focus
  delegate posted an `@auto` summon as a new root message in `bugs`. The
  summoned Agent claimed the work in the root and posted its progress there.

### 1.2 Root causes

1. **One object plays two roles.** A thread is a child Channel, so "a place"
   and "a piece of work" are the same thing. Every piece of work becomes a
   sidebar node, and the shape of the tree records chat history instead of the
   organization.
2. **The platform never decides where work happens.** The launch path
   (`registration-launch-*`, `product-agent-mention*`) has no concept of a
   thread. The only guidance is one soft bootstrap line, and working in place
   is the path of least resistance.
3. **Our own coordinator summons in the root.** The Focus `open-loops` section
   tells the delegate to advance a goal with "one message in the project root
   Channel that summons an Agent".
4. **State is never recorded, so it has to be inferred.** Whether a piece of
   work is done is scattered across messages, archive state, `archiveReason`
   and memory. Most of the Focus prompt reverse-engineers state from chat,
   because there is no authoritative state to read.
5. **Organizing is everyone's side effect and nobody's job.** Anyone can grow
   the tree, and nobody prunes it. The product then adds views (tree, list,
   focus), Archive, and Overview to cope with the result.

## 2. Principles

1. **Reading and doing are different surfaces.** The organization is for
   reading, and conversation is for execution.
2. **Pages describe the present, briefly.** A page holds its current state and
   a concise document, rewritten in place. History lives in conversations and
   revisions, never in the page body.
3. **Conversations are cheap and linear.** They are never nested, and nobody
   has to close, file, archive or distill them. An idle conversation sinks.
4. **Structure is deliberate.** Humans and Agents add, move and remove pages
   on purpose, within the owner's page access. A conversation never creates
   structure as a side effect. The Web page header offers Delete to editors,
   with a confirmation explaining permanent history deletion and automation
   shutdown. Child pages must be moved or deleted first; linked conversations
   remain. The server rechecks access and children when deleting.
5. **Every piece of knowledge has exactly one home.** Knowledge that changes
   with code lives in that code's repository. Knowledge about the organization
   around the code lives in pages (§3.5).
6. **Agents are visible collaborators.** Agents edit through the same real-time
   co-editing humans use, with their own cursor, name and attribution.
7. **One authority per fact.** Page content has one authority, the page
   revision store. Links have one authority, the link record. Presence is
   derived from live state and never stored (guardrails 1, 5, 6).
8. **Language decides, not syntax.** Jev judges which pages a conversation
   belongs to from meaning, not from tags, prefixes or channel types.

## 3. Concepts

### 3.1 Page

- A page is a node in the Space's page hierarchy, for example
  `Company › xMatrix › Relay › Storage`. The hierarchy has the shape of a file
  tree: every page is a markdown document, and headings define its blocks.
- By convention a page opens with **Status**, one or two lines saying what is
  true now, what is in progress and what is blocked. The document proper
  follows: goals, decisions in force, how things work, and open questions.
- Metadata:
  - title;
  - parent and position;
  - permissions (§7);
  - attached configuration: launch targets,
    connector subscriptions and Automations (`pages-live-document.md` §6).
- Pages replace Channel memory, `MEMORY.md`, goals and `PROJECTS.md`. A project
  is simply a page whose document states goals.

### 3.2 Conversation

- A linear message stream whose participants are humans and Agent Instances.
- Keeps everything today's Channel messages have: mentions and summons,
  attachments, reactions, quote-replies within the line (never nested threads)
  and the invocation status chip.
- Has no parent, no children, no archive state and no view modes. Its only
  organizing property is its links to pages.
- Its title is generated from its content and kept current.
- Anyone starts one from anywhere: the conversation list, a page block
  ("Discuss"), a mention, an Automation or Focus.
- **"Discuss" on any selected passage**, of a page or of a message, starts a
  new conversation named by the passage. Its composer opens holding the
  passage as a quote and a link back to where it came from, so the first
  message carries that context to every Agent in it; a mention inside the
  quote stays quoted text. One from a page is linked to the passage; one from
  a message is as open as its source conversation and linked to the same
  pages.

### 3.3 Link

A link is the one durable record that a conversation relates to a page, a block
of a page, or a section of a mounted repository document. Links are created
automatically:

| Source | Behavior |
|---|---|
| Jev at conversation start | Attaches the most relevant pages or blocks; when unsure, the nearest common ancestor |
| An Agent reads or edits a block | The block is linked, and the edit is attributed to that Instance and conversation |
| A pasted page or block reference | Renders as a live card and becomes a link |
| A human drags or removes a link | Manual correction, always allowed |

A conversation inherits context from its linked pages and their ancestors. This
replaces today's inheritance through ancestor Channels.

### 3.4 Presence

Presence answers "who is on this block right now". It is derived and never
stored. It combines:

- people and Agents with the page open, and where their cursors are;
- Agents currently reading or editing the block, from editor awareness;
- Agents whose live Run is in a conversation linked to the block, with their
  invocation state (Working, Waiting, Needs input).

### 3.5 Two homes for knowledge

| Knowledge | Home | Why |
|---|---|---|
| Architecture, APIs, how it works, runbooks, `AGENTS.md`, implementation-bound decisions | The product repository | It must match the code at every commit and is reviewed in the same PR as the code |
| Goals, status, who is on what, roadmap, cross-project decisions, customers, marketing, finance, people | Pages | It does not change with any commit and often spans several repositories or none |

The test: **if the text should change in the same pull request as the code,
it belongs in the repository.**

- **Link or embed repository files, never copy or mount them.** A page that
  needs a repository document links to it on GitHub, or embeds that one file
  so it reads in place (pages-live-document.md §6.5); the embed is read
  through from GitHub when the page is opened. Repositories do not share one
  layout for their docs, so xMatrix assumes none, and the page store never
  holds a copy. (Mounting a repository's `docs/` directory into the page tree
  was built and removed: it assumed that layout and only re-showed what
  GitHub already shows.)
- **Projects without repositories** lose nothing. Teams that do not use git
  only have pages.

## 4. Product experience

### 4.1 Navigation rail

1. **Pages**, at the top. This is the page tree, and the Space root page is the
   landing page.
2. **Conversations.** A flat list ordered by latest activity, with search and
   unread state. Each row shows the generated title, participants, live
   invocation state and the pages the conversation touches.
3. **Tools.** Machines, Schedules, Agents, App, Team, Settings and Platform
   admin, in that order. Each reads like conversations and pages: its list in
   the panel's list column, the item chosen from it on the paper beside it
   (`?item=<key>` names it), pushed over the list on a phone. Schedules lists a
   Space's Automations page by page and makes none; This Machine is the first
   row of Machines on the desktop app; Settings, Platform admin and Team list
   their sections. (Discover and Role Studio left Agents with the retired
   Agent Role.)

**Removed:**

- Overview. Its "what needs attention" role moves to the root page, and its
  management event stream moves to Agents.
- The Channels tree, list and focus views.
- The Archive category.

### 4.2 Reading a page

- **Live co-editing.** The document is edited live by everyone and every Agent
  with access, and it feels like Google Docs: colored cursors, names,
  selections and live typing.
- **Presence on each heading.** The avatars of who is on each section, and
  why. For example: "claude:2 · Working · in *Fix attachment 403*". Clicking
  one opens that conversation beside the page.
- **Conversations beside what they are about.** The live conversations linked
  to the page sit in its margin next to their passage or section, and one
  opens there in its card's place, as a comment thread does in Google Docs,
  so reading or joining one never leaves the page
  (`pages-live-document.md` §4.4).
- **Section footer.** Shows "Last updated by *X* in *conversation Y*, 2 h ago",
  and counts the section's conversations that have gone quiet.
- **Root page.** Carries **Needs attention**, which Focus maintains (§6.3).
- **"Discuss" on any block** starts a conversation that is already linked to
  that block and opens it beside the page.

### 4.3 In a conversation

- **Header cards.** Linked pages and blocks appear as live cards showing the
  title, the current Status line and the last update. The cards change when the
  page does.
- **Inline references.** A message refers to a page as `page:<page-id>`,
  to one of its sections as `page:<page-id>#<heading-slug>`, and to a channel
  as `channel:<channel-id>`. Each renders as a chip with the current title,
  section or channel name, and opens its target; a section reference scrolls
  the page to that section. The id is the reference, so renames never break
  old messages. A reference grants nothing: a channel the reader cannot see
  renders as "private channel", and a page they cannot read does not load.
  A page reference also links the page to the conversation.
- **Typing references.** In the composer, `#` lists the Space's channels and
  `[[` (or `【【` from a Chinese input method) lists its pages;
  `[[page#section` lists that page's sections. The draft shows `#name` or
  `[[Title]]`, and the message is sent with the id tokens above. `#` followed
  by a digit stays text, so `#3484` remains a pull-request number. Editing a
  picked name drops the pick and sends the text as written.
- **Edit events.** When an Agent edits a page, a compact inline event shows
  what changed and links to the revision. It is not a chat message.
- **Summons.** Invocation status works as it does today.

### 4.4 Watching Agents collaborate

When two Agents work on the same page, you see two cursors moving through the
document. Each cursor is labeled with the Agent and its conversation. A human
can type alongside them, and nothing is overwritten.

## 5. Documents: storage and collaboration

### 5.1 Authority

- **PostgreSQL is the page store and the single authority.** It holds:
  - the page tree: nodes, parents, order and permissions;
  - an immutable, linear revision history per page. Each revision is the full
    markdown plus its authors, source conversations and time;
  - the link records.
- **Attachments and large embedded content live in R2.**
- **Every page gets a linear history, not a DAG.** Concurrent editing is
  merged live in the editing session (§5.2), so the durable record never needs
  branches or merges.
- **Revisions provide history, blame, diff and restore.**
- **Deletion is a bounded, audited purge.** A secret written into a page by
  mistake, or a user's deletion request, is removed from the store and its
  revisions without rewriting anyone else's history (guardrails 2, 3).

### 5.2 Live editing session

- **Each page has one Durable Object** that hosts its live session, following
  the one-object-per-entity rule in `docs/architecture/entity-coordinators.md`.
  The object:
  - authorizes every connection from current page permissions and the caller's
    stable identity (a human session or an Agent Run principal);
  - relays edits and awareness (cursors, selection, presence);
  - commits the merged document as a new revision when the session goes idle.
    That revision is attributed to every participant.
- **The engine is Yjs in Web and native clients**, with a ProseMirror editor
  over a markdown-lossless schema (`pages-live-document.md` §4.1). yrs, the official Rust implementation
  of the same protocol, is used where the CLI, runtime or daemon joins a live
  session. The repository has no CRDT or editor dependency today.
- **CRDT state is session state, not authority.** A new session loads the
  latest revision. Offline and weak-network edits merge when the client
  reconnects.

### 5.3 Agents as editors

- **Reading.** Agents read pages as markdown through `xmatrix page read`, with
  block ids. Files remain the Agent's native medium.
- **Writing.** `xmatrix page edit` submits a whole-document edit against the
  revision the Agent read. The page's live session is the only writer of
  page content. It three-way merges the edit with the current text, including
  edits that humans have not committed yet, saves the result as a revision
  (which authorizes it), and only then applies it to the live text as minimal
  operations in one transaction, under the Agent's cursor. If the edit overlaps a newer change, it
  is refused with the current text, and the Agent merges and retries. This is
  a freshness gate, not a lock.
- **Cursor.** Agent awareness carries the Agent's display name, color, Instance
  and conversation. Reading moves the cursor, and writing streams block by
  block.
- **Suggest mode.** A page can be set so that Agent edits appear as proposed
  changes for a human to accept. By default Agents edit directly.

### 5.4 Git as an access protocol

For each user, the Hub exposes the page store as a git remote whose content is
only the pages that user can read. Commits are derived deterministically from
revisions.

- **Git users** can clone, pull, edit in an IDE and push. A push is an ordinary
  authorized edit request: it is checked, attributed and committed as revisions.
- **People with different permissions clone different views**, so nothing
  leaks through history.
- **Teams that do not use git never see it.**
- **Mounted repository documents stay in their real repositories** and do not
  pass through this interface.

`git clone https://<hub>/git/<space>.git`, with an xMatrix token as the
password, gives the reader a repository of the pages they can read now. A page
with pages below it is a directory whose `README.md` is its text; any other
page is `<title>.md`. Each commit is one page revision, authored by whoever
wrote it, with `xMatrix-Page`, `xMatrix-Revision` and `xMatrix-Conversation`
trailers, so the same reader always gets the same commit ids.

A push must build on the reader's current history, and each changed page
becomes a revision by the pusher, merged with concurrent edits the same way as
any other edit. A new Markdown file becomes a page below the page its
directory belongs to (a person's act, like any new page). Removing or renaming
a page happens in xMatrix, not by a push, and merge commits are refused. The
Hub's own commits then replace the pushed one, so `git pull --rebase` finds
nothing left to apply.

### 5.5 Public pages

A Space owner or admin publishes a page, and anyone can read it at
`/p/<space>/<page>` without signing in.

- **Only a page every member reads can be public.** A restricted page, or a
  page below one, cannot be published, and a published page that later becomes
  restricted stops being public without being unpublished. The check runs on
  every read.
- **Publishing is a person's act.** Agents keep public pages current like any
  other page, but they never publish or take one down.
- **One page at a time.** A published page lists the published pages directly
  below it; publishing a page does not publish its children.
- **Rendered on the server**, so search engines and link previews read it, with
  who is on the page right now (names and what they are doing, never their
  conversations) and a "Live · maintained by agents on xMatrix" footer. The page
  re-reads itself while open, so Agent edits appear.

### 5.6 Claims

A claim is a lease on a page block (a heading slug, or the whole page) that
says "alice's claude:1 is on this". Presence shows who is looking; a claim
shows who took the work.

- **Whoever can edit the page claims.** An Agent's claim is held by its
  Instance and counts against its owner; it points at the conversation doing the
  work.
- **One holder per block.** A second claim on a held block is refused with who
  holds it. A Space owner or admin can open a block for competition, and then
  several claims run at once.
- **Claims lapse.** Each lasts 5 minutes to a day (two hours by default);
  claiming again renews it. A lapsed claim frees the block with no cleanup.
  The holder, the person it counts against, or a Space owner or admin releases
  it early.
- **Live.** Everyone on the page sees claims appear and go under "Who is on
  what" as they change. Agents use `xmatrix page claim`, `page claims` and
  `page release`.
- **Pull requests do claimed work.** A pull request names the block it works on
  with the block's link (Link, next to the block). The GitHub App publishes an
  `xmatrix/claim` check on it: it passes when the author holds a claim on that
  block, directly or through one of their Agents. The author is identified by
  the GitHub account they linked in their profile. Otherwise it fails and says
  how to claim. Maintainers can make the check required. A pull request that
  names no block gets no check, so a required check keeps it out. Merging the
  pull request completes the claim.
- **Pre-review before a maintainer.** When a claimed pull request opens or
  gets new commits (drafts excepted), it gets its own review conversation on
  the block. An Agent of the Space owner's reviews it there. The Hub hands it
  the change, the checks on its head commit and the repository's other open
  pull requests. It checks four things: the change matches the block's scope,
  tests pass, it duplicates no other pull request, and it follows the Space's
  governance page. It answers in the conversation and records its verdict with
  `xmatrix page pre-review`, which becomes the `xmatrix/pre-review` check on
  the pull request's current head.

## 6. Keeping pages true

### 6.1 Write-back contract

When a conversation changes the state of something a page describes, the Agent
that did the work updates that page before it finishes.

- **Where the edit goes.** If the knowledge lives in a repository, the Agent
  edits it in the pull request and updates only the page's Status line, linking
  to the pull request.
- **When the state changes.** Events that change what a block describes
  (merged pull requests, releases, lapsed claims, finished Automations) ask
  the responsible Run, then Focus, to write back within minutes
  (`pages-live-document.md` §5).
- **At the end of a Run.** `xmatrix page edit` records the write-back, and
  `xmatrix page done` records that the work changed nothing on the pages. The Agent writes back before voluntarily stopping its Instance; a completed
  turn does not terminate the Run.

### 6.2 Maintenance style

- **Rewrite in place.** Pages stay short and current; they are not appended to.
- **Remove superseded statements.** They are not struck through.
- **Keep decisions only while they are in force.**
- **Explanations of why something changed** belong to the conversation, which
  stays reachable through the block's attribution.

### 6.3 Focus becomes the gardener

Focus stops reverse-engineering open loops from chat. The page tree is the
work index. `xmatrix channels` stays the human's full conversation list, and a
named conversation stays readable; it is not a catalog an Agent scans. Focus
reads every page. It opens one conversation only when a section still describes
that work as unfinished and names the conversation. When the section states the
current outcome, the conversation stays where the human can find it and is not
read again to recover that outcome. A section that has become a log is rewritten
in place to the current state. There is no archive flag and no hidden Focus
state on a conversation. Focus does five things:

- **Verifies claims against reality.** It checks Status lines against pull
  requests, releases, deploys and issues, and corrects stale ones.
- **Finds neglected blocks.** A neglected block is a goal or in-progress item
  with no presence and no update within its stated cadence. Focus lists these
  in Needs attention.
- **Keeps pages concise.** It merges duplicates and removes superseded
  content.
- **Keeps the two homes apart.** Page prose that restates repository docs is
  replaced by a link. Organizational content found in a repository is
  proposed for a page.
- **Advances a neglected block** by starting or continuing a conversation
  linked to that block, addressed to whoever can close it. It never posts
  summons into a shared root.

## 7. Permissions

- **Pages** carry read and edit permissions, inherited down the hierarchy.
- **Conversations** have participants. Visibility follows participation plus
  any explicit sharing.
- **Agents.** What an Agent can read or edit is the intersection of three
  things:
  - its Run's authority;
  - the conversation's scope;
  - each linked page's permissions.
- **Where it is checked.** Every page connection, edit, mirror read and git
  operation is authorized at the owning server boundary (guardrail 1).
- **Links grant nothing.** A card for a page the viewer cannot read renders as
  "restricted".

## 8. What goes away

| Today | Replaced by |
|---|---|
| Channel hierarchy, parent/child Channels, `channel move` | Page hierarchy |
| Threads as child Channels, `xmatrix channel thread` | Conversations plus quote-replies |
| Channels tree / list / focus views (`ChannelChildView`) | One conversation list |
| Archive (archive state, `archiveReason`, archive approval, archive-kills-instances, Archive category, Focus reason backfill) | Idle conversations sink; whether something is done is recorded as page state |
| Overview (`sidebar-management-overview-model`) | The root page's Needs attention section; the event stream moves to Agents |
| Channel memory, propose → canonical, `MEMORY.md`, goals, `PROJECTS.md` | Pages |
| Space mirror `INDEX.md` hierarchy | Page-tree projection |
| Focus open-loop inference from chat | The Focus gardener (§6.3) |

## 9. How this compares

| Product | Where work lives | Unit of work | Where progress lands | Nesting |
|---|---|---|---|---|
| Slock / Raft | Flat channels | Task converted from a message, with enforced claim | The task's thread | Flat |
| Cumora (yetone) | Chat plus Kanban and calendar | Claimed work unit | Chat | Flat |
| Multica | Projects | Issue | Issue comments plus separate logs | Flat |
| Linear | A separate chat product | Issue / Project | An Agent extracts issues from chat | Flat |
| Notion / Feishu | Docs and databases | Page, row | Humans, or an Agent that someone asks | Pages |
| **xMatrix** | Pages | Conversation linked to blocks | A live co-edited page | Pages only |

- **The alternatives.** Competitors either attach structure to chat (Slock,
  Cumora, Buzz) or keep structure that humans must maintain (Notion, Feishu).
  Ticket-first products (Multica, Linear) turn every piece of work into a
  persistent object. Tickets then pile up the same way our 1,237 Channels
  did.
- **Prior art in the same direction.** Karpathy's "LLM wiki" and GitLab's
  handbook-first practice both treat the durable organization as a concise,
  maintained body of documents, and conversation as disposable.
- **What nobody ships** is the combination:
  - cheap linear conversation;
  - pages that Agents keep current as they work;
  - live collaboration that is visible down to the block.

## 10. Success measures

- **Page tree size.** The page tree reflects deliberate structure. For the
  x-matrix Space that means about 130 pages instead of 1,237 Channels.
- **No Agent posts in a shared root.** No such root exists.
- **Accurate Status lines.** Focus verifies Status lines against external
  artifacts, and the share found stale per review trends to zero.
- **One page answers the question.** A reader can learn the state of X and who
  is on it from one page, without opening a conversation.
- **A smaller Focus prompt.** The evidence and archive sections are no longer
  needed.
