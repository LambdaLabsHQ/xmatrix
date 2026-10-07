# Pages: the live document

Status: accepted and largely shipped (2026-09-27; see §8). Owner: Yiming Hu. Refines §3.3, §3.4, §4.2 and
§5.2 of [`pages-and-conversations.md`](pages-and-conversations.md), which stay
the parent design.

A page must be at least as good to work in as Google Docs, and collaboration
on it happens through **real-time editing of one concise document**, not
through asynchronous review. People and Agents are both collaborators, so what
each can perceive about the page, its facts and each other has to be
designed for both.

## 1. What is missing today

- **Agents are half blind.** `xmatrix page read` returns the body, the
  revision and the last editor. It does not say who is on which block, what
  is claimed (that is a separate `page claims`), which Agent is working on
  which block in which conversation, how old or verified a statement is, or
  that a block changed after the Agent read it; it finds out only when its
  edit conflicts.
- **People are half blind too.** They see cursors and header avatars, but not
  what an Agent intends, how fresh a statement is, or what changed since they
  last looked.
- **The editor is a markdown code editor.** CodeMirror with live preview shows
  `#` and `**` on the lines being edited, and has no toolbar, no selection
  menu and no `/` insert.
- **The page's surroundings are a flat list.** Presence, claims, links,
  mounts, publishing and governance share one column; creating a page or a
  mount uses `window.prompt`; history is raw text without a diff.
- **Pages are kept current late, or not at all.** The write-back contract
  (parent §6.1) must apply during work as well as before the Agent stops. A merged pull request, a release, a lapsed claim or
  a finished Automation changes how things stand without anyone being asked
  to update the page, and Focus notices only on its next sweep.
- **Automations and connectors are bound to conversations.** After the move
  to pages a conversation is linear and sinks when idle, so a repository
  subscription or a schedule bound to one recreates the `bugs` Channel.

## 2. Principles

1. **Collaboration is Google Docs; editing is Typora.** Named cursors,
   follow, margin discussions, suggestions, version history with diff and
   restore, an outline, a share dialog, offline merge, and paste of rich
   text and images. There is no formatting toolbar. People type markdown,
   and the caret's block and marks show their markers locally (`#`, `**`,
   `](url)`). A selection offers collaboration, not formatting.
2. **Collaboration is live, the document is concise.** Editing mode is the
   default for people and Agents; suggestion mode is a per-page option for
   sensitive pages. Discussions, AI answers and annotations never enter the
   body; the body states what is true now.
3. **One awareness model, two renderings.** Every block has one derived
   awareness state (§3). People see it drawn on the page; Agents read it as
   text in `page read` and receive it as events. Anything a person can see
   about a block, an Agent reading it can read, and an Agent's state and
   intent are visible to people. It is derived from live sources and never
   stored (parent §2.7).
4. **Facts with an authority are referenced, not restated.** A pull request,
   release, CI run, schedule or claim is embedded as a live reference that
   renders its current state. Prose holds what has no other authority.
5. **Markdown stays the Agent's medium and the durable format.** Revisions,
   git and Agent edits remain markdown; the editor is a view over it.

## 3. Awareness

Each block's awareness has four layers.

| Layer | Question | Sources |
|---|---|---|
| Facts | Is this still true? | Revision attribution (who, which conversation, when); the last Focus verification; resolved live references |
| Presence | Who is here, doing what? | Editor awareness of people and Agents; live Runs in linked conversations with their invocation state; each Agent's intent line |
| Change | What changed since I looked? | Revisions after the reader's last read (people: last visit; Agents: last `page read` in this Run) |
| Intent | Who has taken this? | Claims, with their conversation and pull request |

- **Intent line.** An Agent on a block publishes one line of what it is
  doing: the note on its claim, or else the title of the conversation its Run
  is in plus its invocation state. For example `claude:3 · Working · adding
  Phase 5 to Next steps`.
- **Permissions.** Presence in a conversation the reader cannot read shows
  "an Agent is working here" with no title (parent §7).
- **Freshness.** A block is *verified* (Focus checked it against its sources
  after its last edit), *aging* (no update within the page's stated cadence),
  or *contradicted* (a live reference or Focus disagrees with the text).

### 3.1 How an Agent perceives it

`xmatrix page read` puts awareness in the front matter, never in the body,
so an Agent's edit cannot write it back:

```
---
pageId: 227ecdfb-…
revision: 12
blocks:
  status: {updated: "3h ago by claude:1 in \"Phase 4 release\"", freshness: verified}
  next-steps:
    claimed: codex:2 "Phase 5 contract migration" until 2026-09-27T16:00Z
    working: claude:3 Working in "Migrate Lambda Labs"
    viewing: Yiming Hu
live:
  "github:pr/LambdaLabsHQ/xmatrix#2963": merged · released v0.16.444
---
```

- `page read --since <revision>` returns only what changed, as a diff per
  block with its authors and conversations.
- **Change events.** A Run that read, claimed, linked or edited a block
  receives an event at its next turn boundary when someone else changes that
  block: who, in which conversation, and the diff. It learns of overlap
  before its edit conflicts, not after.
- `page claims` stays, but `page read` already shows claims per block, so an
  Agent sees that work is taken before it starts.

### 3.2 How a person perceives it

Everything a person perceives about a page is drawn on the page, at the place
it concerns. There is no panel of lists beside the document: a list repeats
what the document already shows, and it separates each fact from the text the
fact is about.

- **Header**: the save state, and everyone on the page as a stack of
  avatars. The page's name is here only when the document does not already
  open with that heading, and then as plain text, not a field. Hovering an
  avatar says who it is, what they are doing, where and in which
  conversation; clicking one scrolls to them. Idle people are dimmed. Beside
  the avatars: the page's conversation count (§4.4), History and Share. There
  is no ⋯ menu: each setting sits where it acts (§7). As Google Docs does with its clock icon, hovering History says
  who changed the page last and when, and a dot on it means the page changed
  since this person last read it.
- **Cursors**, as in Google Docs: a line in the person's colour with their
  name above it. The name shows while they move or type and hides about five
  seconds later, leaving a square at the caret's top; hovering the caret
  shows it again. Clicking an Agent's label opens its conversation beside the
  page (§4.4).
- **A cursor stays while its owner is on the page**, and goes when they
  leave; there is no linger timer. A person is on the page while it is open,
  and idle (dimmed) after ten minutes in a hidden tab. An Agent is on the
  page while the Run that read or edited it is live: its caret rests where
  its last edit ended, dimmed while the Run is not working on a turn, and
  goes when the Run sleeps. The page session keeps each Agent's resting
  caret with its state and renews it alongside readers' heartbeats; readers
  show it only for a live Run.
- **What others just wrote** is tinted in their cursor's color where it
  landed and fades within a few seconds, so a person watches an Agent's edit
  arrive as well as a person's typing. The session writes an Agent's edit
  under the Agent's awareness id, which is how the editor knows whose text it
  is.
- **The top and bottom edges** of a long page name who is out of view above
  or below, placed by their cursor where they have one and by their section
  otherwise: "claude:2 is editing below". Clicking scrolls to the nearest of
  them; clicking an avatar in the header does the same.
- **Headings** carry who is on the section: the people and Agents in it, and
  the Agents working in a conversation linked to it even when they do not
  have the page open, each with its state; the claim flag with its holder and
  pull request; *Update owed* where claimed work ended and nobody wrote it
  back (§5.3); its conversation count (§4.4); and the freshness mark (§5.4).
  Hovering a heading, or
  editing in its section, offers Discuss, Copy link, Claim (Release on your
  own claim) and Attach at the heading's right edge (§6).
- **No change log in the text.** As in Google Docs, who changed a section
  and when is not written under it. *Show editors* on a selection says who
  last changed that section, when and in which conversation, with a link to
  History (parent §4.2).
- **Margin**: the conversations about the page, each beside what it is about
  (§4.4).
- **The scrollbar** marks where others are, where discussions are and which
  sections owe an update.
- **What changed since this person last read the page** plays as they read
  it. How far each person has read each page is theirs and kept by the Hub
  (`data.page_reads`, `GET`/`PUT /api/spaces/:spaceId/pages/:pageId/read`),
  so it follows them across devices; it is the newest revision they have had
  on screen, moves only forward, and is set once the page has been in view at
  a revision for a moment. Opening the page diffs the revision they last read
  against the document now, block by block and then word by word inside
  changed blocks: new text surfaces out of a blur on a tint that fades, new
  blocks rise in, and text taken out is struck and folds away where it stood.
  Each change plays when it first scrolls into view. A first visit shows
  nothing as changed. Agents have no read state.
- **Opening a page draws it as the editor will.** Until the live session has
  synced, the page shows its prefetched document rendered from the same
  document schema and list item view as the editor, with the margin's room
  already held, so nothing moves when the editor takes its place. Repository
  documents (§7) render the same way.

## 4. Editing

### 4.1 Engine

- **ProseMirror over a Yjs `XmlFragment`**, replacing CodeMirror over
  `Y.Text`. The document renders. Markdown markers are decorations on the
  caret's block and marks, not stored in the fragment, so collaborators see
  rendered text and carets.
- **The schema is what markdown carries losslessly**: GFM headings, lists,
  task lists, tables, code, quotes, links and images, plus inline nodes that
  serialize to markdown link syntax: page references, mentions and live
  references. A round trip markdown → document → markdown is the identity on
  canonical markdown, and a test holds it.
- **The page session stays the only writer.** An Agent's `page edit` is
  three-way merged as markdown against the session's serialized document, as
  today; the merged markdown is parsed and applied as a minimal structural
  update to the fragment in one transaction under the Agent's cursor.
  Revisions store the serialized markdown, so history, git and blame are
  unchanged.
- The Rust side (`yrs`) reads and writes the same fragment when the CLI or
  daemon joins a session.

### 4.2 Surface

- **Typing is the formatting.** Headings, lists, tasks, quotes, fences,
  dividers, emphasis, code, links and images are written as markdown. The
  caret's heading, quote or code fence, and the marks it sits in, show their
  markers in that line's type size and font. Backspace on the nearest marker
  removes it: one heading level at a time, then the quote, and a mark's
  delimiter drops that mark. Shortcuts still apply marks. A typed URL followed
  by a space becomes a link.
  Clicking a link's visible destination edits the address.
- **Table controls** appear only while the cursor is in a table.
- **Selection menu**: *Ask AI*, *Ask an Agent to change*, *Discuss*, *Claim*,
  *Copy link*.
  - *Ask AI* starts a discussion on the selection addressed to xMatrix and
    opens it beside the page (§4.4), where the answer arrives; it changes
    nothing in the text.
  - *Ask an Agent to change* takes one instruction; the edit arrives as a
    suggestion on the selection to accept or reject.
  - *Discuss* starts a conversation anchored to the selection (§4.3).
- **`/` insert**: heading, list, task list, table, page reference, live
  reference, mention.
- **Suggestions** render inline as tracked changes with accept and reject per
  change, and replace the History-panel accept flow.
- **History**, as Google Docs' version history: versions grouped by day,
  each with its time and its editors beside a dot in their colour; the
  newest opens first, and the open one shows its additions highlighted in
  its author's colour and its removals struck through, with its conversation
  and restore. One colour per person or Agent everywhere: caret, avatar ring
  and History.
- **Outline** of the page's headings in the left rail under the tree; share,
  publish and access in a dialog from the header.

### 4.3 Discussions are anchored conversations

There is no separate comment system. A discussion is a conversation linked to
a range of text:

- A link gains an optional **text anchor**, a pair of Yjs relative positions
  plus the quoted text, beside the existing page and block (parent §3.3). The
  anchor follows edits; if its text is deleted, the discussion falls back to
  the block.
- The passage is highlighted, and the discussion sits beside it in the margin
  (§4.4).
- A discussion is resolved when its outcome is written into the body; the
  Agent that writes it marks the link resolved, and the highlight and card
  go. The conversation stays reachable from the block's history and the
  page's conversation list.

### 4.4 Conversations beside the page

A page and the conversations about it are read together. Each conversation
linked to the page appears beside what it is about and opens there; reading
or joining one never leaves the page.

- **Where it sits.** A discussion sits beside its passage. A conversation
  linked to a section sits beside the section's heading, and one linked to
  the whole page beside the title.
- **Which ones.** Open discussions, conversations with an Agent live in
  them, conversations with messages the reader has not read, and
  conversations active in the last day. The others have sunk (parent §3.2):
  the heading's conversation count includes them, and the conversation list
  shows them.
- **A card per conversation**, drawn as a comment is in Google Docs: the
  quoted passage of a discussion (or the title of a conversation about a
  section), the last message with its author's avatar, name and age, the
  Agents live in it with their state, and the reader's unread count. A card
  at rest is flat, a tint off the page; the one being read lifts. Cards
  beside one section stack; the card being read lines up with its anchor
  and the others make room, and its passage is marked. Clicking a
  highlighted passage brings its card forward; the caret goes there as usual.
- **Opening one** (its card, a bubble, an Agent's cursor label or a heading
  avatar) turns its card into the selected thread, as in Google Docs: raised,
  level with what it is about, on the same edges as the other cards, with
  one avatar size and text indent throughout, and as tall as what it says up
  to a cap, past which its
  messages scroll. Messages read as comments (a small avatar, name and time
  on one line, the text below) and a one-line reply box closes it; the
  card's head carries resolve, *Open in Conversations* and close. The other
  cards stay beside the page and make room above and below it, and it
  scrolls with the document. One conversation is open at a time; closing it
  brings its card back. A conversation the page does not link yet opens
  beside the title. The address names both
  (`?page=<id>&conversation=<id>`), so the pair can be shared, and Back
  closes the conversation.
- **The thread is the conversation, at comment size.** It is the product's
  one conversation surface, so mentions and summons, approvals and the Agent
  work dock work there; per-message tags and actions, attachments and the
  full header stay in *Open in Conversations*, which gives it the whole
  window.
- **The conversation list.** The header's conversation count, a heading's
  count open the list of every
  conversation linked to the page, grouped by section, including resolved
  discussions and sunk conversations; open discussions resolve from it too.
- **Starting one.** *Discuss* on a selection or a heading, and *Ask AI*,
  create the conversation already linked there and open it beside the page
  with its composer focused.
- **Narrow windows** have no margin: when the page has no room for a full
  document column beside it, passages stay highlighted with a bubble and
  headings count their conversations and mark the Agents working in them
  (with the margin, the cards say this and the headings do not), and an opened conversation docks to
  the right of the document instead. History docks it the same way.
- **Phones** open a conversation as a screen pushed over the page; Back
  returns to the same place in the page.
- **Derived, never stored.** A card is the link plus the conversation's own
  state for the reader. The page's link listing carries, for each
  conversation the reader may open, its title, last message, the reader's
  read position and the Agents live in it, and realtime events keep them
  current. A conversation the reader cannot open does not appear (parent
  §7).

## 5. Keeping pages current in time

A page is only worth reading if it is current within minutes of the change it
describes. Maintenance is therefore driven by the events that change state,
not by the end of a Run or a periodic sweep, and every change has exactly one
party responsible for writing it back.

### 5.1 Less to maintain

- **Live references keep themselves current** (§2.4): a pull request's state,
  a release version, a CI result, a schedule's next run or who holds a claim
  is never restated in prose, so it cannot go stale.
- **Presence and claims are not page text.** Who is on what is drawn from
  claims and live Runs (§3); nobody edits a page to say they started or
  stopped.
- **Pages stay short** (parent §6.2), so updating one is a small edit.

### 5.2 Events that ask for an update

A section **owes an update** when something that changes what it says
happened after its last change and nobody has written it back. The debt is
derived, never stored as a queue: from the event's own record and the page's
revisions.

| Event | Section | Derived from |
|---|---|---|
| A pull request that names the section is merged | The section it names | The claim it completed |
| A claim is released or lapses | The claimed section | The claim |
| An Automation occurrence anchored to the section finishes | Its section | The occurrence (§6) |
| A live reference in the section changes state (§5.4) | That section | The reference |

An owed update is settled by the next edit to its section, or by the Run
saying nothing there changed (`xmatrix page done`, which records it on that
conversation's ended claims). Anything older than a week stops counting.

### 5.3 Who writes it back

1. **The Run that did the work**, at the moment the state changes. A merged
   pull request is announced by GitHub in the conversation that held the
   claim, so its Run, if still live, hears it on its next turn and answers
   with `xmatrix page edit` or `xmatrix page done`. A Run that releases a
   claim is told the same by `xmatrix page release`. Every Run is asked when
   the state changes, not only when it exits.
2. **Focus** takes what is still owed: `page read` marks each such section
   `owed:`, and the Focus scan treats those first.
3. **People see what is still owed.** The section's heading says *Update
   owed*; hovering says the event that caused it, and clicking opens the
   conversation.

### 5.4 Freshness

The freshness mark (§3) is computed from the same sources:

- **Verified**: edited or checked after the last event on the block.
- **Update owed**: a write-back request is open.
- **Aging**: no edit and no event within the page's stated cadence, for goals
  and in-progress blocks that name one.
- **Contradicted**: the prose disagrees with a live reference in the block or
  with what Focus found (a Status says "in review" for a merged pull request).
  A contradiction opens a write-back request at once.

Agents read the mark in `page read` (§3.1) and people see it on the section's
heading (§3.2), so nobody acts on a stale block without being told it is
stale.

### 5.5 Measures

- Time from an event to the write-back on its block: minutes, p90 under 15.
- Blocks that owed an update for more than an hour: zero.
- Contradicted blocks found by Focus rather than by an event: trending to
  zero, because events should catch them first.

## 6. What is attached to a page

A page describes an area, so the machinery that works on the area attaches to
the page, and the page is the one place to find, read and change it. Each
piece is shown where it acts (§7): an Automation in its section's text, a
connector's conversation beside its section. The rail's Schedules and App are Space-wide indexes over the same
records, never a second place they live.

- **Automations** live in the body (§6.1).
- **Connectors.** "Issues and pull requests of `LambdaLabsHQ/xmatrix`" is a
  repository subscription in a conversation linked to the section, so they
  arrive where the page points, and their outcomes reach the page through
  write-back (§5) and Focus.
- **Launch targets** (parent §3.1).

### 6.1 An Automation is a live reference in its section

An Automation is a standing rule, "when this happens, have an Agent do that,
so that what this section says stays true". A conversation is linear and
sinks when idle, so an Automation never belongs to one; it belongs to the
section it keeps true, and it is written there:

```
## 1. Architecture: no bloat
- Cadence: [Code audit](xmatrix:automation/7c5c472c-…)
```

- **The reference is the anchor.** The Automation's section is the section
  whose text holds its reference in the page's head revision; moving the
  reference moves the Automation, and renaming the heading changes nothing.
  The Automation's page is fixed when it is created; a reference to it on
  another page is an ordinary link.
- **The editor renders it as a chip** with its triggers, whether it is
  running, the next run and a link to the last one, so the page never restates
  a schedule in prose (§2.4) and prose and schedule cannot disagree. `page
  read` lists it under `live:` like every live reference.
- **Deleting the reference pauses the Automation** (reason `detached`); it is
  not deleted. Putting the reference back, by undo or by restoring a
  revision, resumes one that was paused only for that reason. A heading's
  *Attach* offers the page's detached Automations with *Put back here*; the
  Space's Schedules list every Automation, with *Delete*.
- **Each Automation works in a conversation of its own**, created with it and
  linked to its section. Each occurrence is a fresh Run in that conversation
  and writes back to the section (§5.2). The conversation is where it runs,
  not what it belongs to.
- **Nothing runs unanchored.** An Automation is created only in a page
  section: from the page, `xmatrix page automation create` or a Management
  Agent acting through the page. The Space's Schedules only lists and
  manages them. There is no message macro for it: saying "audit
  this every 12 hours" in a conversation is an ordinary request an Agent acts
  on by creating the Automation where it belongs.

### 6.2 Triggers

Every Automation has a cadence, and a page's Automation may add event
triggers. A trigger never queues work; it makes the next occurrence due now.
A GitHub trigger records the installation of the Space's GitHub connection
that covers its repository, and fires only on that installation's events
while the Space is still connected to it.

| Trigger | Fires when |
|---|---|
| `every <interval>` | The interval has passed since the last occurrence (the existing cadence bounds) |
| `merged <owner/repo>[@branch] [paths…]` | A pull request is merged into the branch (default: the default branch), touching one of the paths if any are given |
| `ci-failed <owner/repo>[@branch] [workflow]` | A workflow run on the branch concludes with failure |
| `owed` | A claim on its section is completed by a merged pull request or released (§5.2); a lapsed claim is left to Focus |

Events coalesce: an occurrence takes every event recorded before it (the last
ten), and events that arrive while one is pending or running wait for a
single follow-up occurrence. Events run an Automation at most once an hour: one that
arrives sooner waits for the occurrence that takes it, which bounds the loop an
Automation would start by triggering on changes its own runs make. So "review every merge
to main, and sweep every 12 hours" is one Automation with two triggers, and a
burst of merges costs one review of the combined change, not one per merge.
The occurrence's message names the events that fired it, so the Run knows
which change to look at.

### 6.3 Who reads and changes it

Access follows the page, for people and Agents alike:

- **Read**: anyone who can read the page, including every Agent Run whose
  owner can; there is no birth-conversation restriction.
- **Create, edit, pause, resume, move, delete**: anyone who can edit the page.
  On a suggest-only page an Agent's change is refused and it asks a person,
  because an Automation is not text a person can review as a suggestion.
- **Authority does not change hands in place.** An Automation runs with its
  author's Machines, Agents and name. Pause, resume, move and delete keep the
  author. An edit by anyone else atomically replaces it with a new Automation
  whose author is the editor (an Agent's author is its owner), and the
  reference in the body is rewritten to the new id in the same page revision.
  Every change is a page revision, so History shows who changed which
  Automation, in which conversation.

Agents use `xmatrix page automation list|create|edit|pause|resume|delete
<page-id>`, with `--block <heading-slug>` choosing the section for create and
move; the command writes the reference into the section as part of the same
change.

### 6.4 Storage and execution

- `data.automations` gains `page_id`; the section is derived from the
  reference, never stored. The Channel-family authority of the Automation's
  conversation keeps executing it exactly as before: alarm, occurrences,
  deadlines and cancellation are unchanged (docs/architecture/
  automation-execution-cancellation.md).
- Each committed page revision reconciles its references with the page's
  Automations: a reference that disappeared pauses its Automation as
  `detached`, one that reappeared resumes it, and a reference to an unknown
  or foreign id renders as a broken reference.
- Event triggers are matched by the Hub where the event arrives (the GitHub
  webhook, the owed-update derivation) against an index of enabled
  Automations by trigger key, and delivered to the Automation's authority as
  "due now".
- There is no Channel-scoped Automation: the page creates one on one of its
  sections, and a Management Agent's `automation_*` operations act through the
  page as its owner. The contract migration moved the existing ones: each
  one's reference was appended to the page its conversation was last linked
  to, or else its Space's first root page.

## 7. Around the page

There is no side panel. What its tabs held is shown where it acts:

| Was | Now |
|---|---|
| Now: presence, claims, running Agents | Header avatars, cursors, and each heading's avatars and claim flag (§3.2) |
| Discussions | Cards beside their passages and the conversation list (§4.4) |
| Attached: Automations | Chips in the section they keep true (§6.1); *Attach* on a heading adds one or puts a detached one back; the Space's Schedules list them all |
| Attached: connectors | A conversation linked to its section, a card like any other; *Attach* on the heading adds one |
| History | A mode of the page: the margin lists revisions, and the document shows the chosen one's changes colored by author, with restore |
| Settings: publishing, suggestion mode | The Share dialog from the header |
| Settings: project governance | Open participation on the Space in Team; the governance page in Share (only owners and admins edit this page), both for Space owners and admins |
| The move to pages | A notice on the page while an Agent's draft waits for an owner or admin |

A phone shows the same things on the page itself: avatars and the
conversation count in the header, headings and bubbles in the text,
and Share and History in the page's top bar.

Creating a page uses one in-app title dialog for the desktop list and
Ctrl/⌘+N shortcut, the phone's existing FAB, the empty list, and a parent row's
sub-page +. It works in native WebViews without browser prompt support.
Blank titles cannot be submitted; pending creation disables further submission
and dismissal. A failed request keeps the title and shows the error for retry.
Success refreshes the tree and opens the new page under the chosen parent.

## 8. Build order

Shipped:

1. Editor engine and schema with the round-trip test; Agent edits through the
   structural update; `/` and the selection menu (v0.16.464). The formatting
   toolbar from that pass was removed: the caret's line shows Typora markers,
   and table controls show only inside a table.
2. Awareness: per-block aggregation, `page read` front matter; Now bar,
   heading avatars, follow, section footer (v0.16.467); `page read --since`
   (v0.16.470).
3. Anchored discussions with resolve, and Ask AI / Ask to change on a
   selection (v0.16.470).
4. Owed updates derived from ended claims, GitHub's write-back request on a
   merged pull request, the Focus scan treating owed sections first
   (v0.16.470).
5. The Attached tab, with Automations and GitHub subscriptions in
   conversations linked to a section (v0.16.470).
6. Side-panel tabs and history diffs (v0.16.470); save state, named fading
   cursors, title rename, table controls and links from URLs (v0.16.471).
7. Conversations beside the page (§4.4): the page's links carry each
   conversation's summary for the reader and each section's working Agents;
   margin cards, the conversation docked beside the page, presence and claims
   on headings, the header's avatars, Share, History as a mode and the ⋯
   menu, with no side panel (§7).

Open:

- Automations as live references in their section, with page access, event
  triggers and the removal of Channel-scoped Automations (§6).
- Change events pushed to a Run when a block it read or claimed changes
  (§3.1), and "changes since your last visit" for people.
- Live references and freshness for GitHub issues and pull requests (§5.4).
- Suggestions inline as tracked changes, images.
