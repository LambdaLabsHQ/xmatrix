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
   release, CI run, schedule, claim or repository file is embedded as a live
   reference that renders its current state. Prose holds what has no other
   authority.
5. **Markdown stays the Agent's medium and the durable format.** Revisions,
   git and Agent edits remain markdown; the editor is a view over it.

A whole-document Agent edit is authorized and committed before it is shown.
It is then typed into the live document as a person types it
(`page-typing.ts`):

- **Structure first.** The edit's structure goes in at once, in one small
  update: what it removes, restructures or re-marks. A new block stands with
  its first word.
- **Then the words.** Its words are typed into the document's text, a few at a
  time over about two seconds, or, while a person has the page open, a word at
  a time at a reader's pace (§4.2), which its author does not wait on. Each
  step is a CRDT insertion anchored to the
  word before it, so people typing anywhere meanwhile, even in the same line,
  and other Agents typing their own edits merge with it as keystrokes do. No
  step parses or rewrites the page.
- **Every moment reads back as itself.** The page at each moment of the typing
  reads back from Markdown as itself: no block stands empty, no line ends in a
  space, and no structure is ever half there. This matters because another
  Agent's edit merges through the Markdown.

Agents that read one revision and change neighbouring lines both get their
edit: whole lines merge first, then the words of lines that touch. Commits are
announced in commit order, before their typing.

Session storage keeps the words still to type beside the committed base and
the CRDT. A person's save and a restart finish the typing first: the save
commits the head with the person's edits, and the restart types the rest in at
once. Neither repeats the commit or attributes an unfinished typing to the next
person who edits. When the last Agent finishes and nobody has edits pending,
the page is the head exactly, whatever overlapping edits left. Text that differs
from the committed page while no person's edit is pending is no person's, so a
restored session reads as its committed page.

## 3. Awareness

Each block's awareness has four layers.

| Layer | Question | Sources |
|---|---|---|
| Facts | Is this still true? | Revision attribution (who, which conversation, when); the last Focus verification; resolved live references |
| Presence | Who is here, doing what? | Editor awareness of people and Agents; live Runs in linked conversations with their invocation state; each Agent's intent line |
| Change | What changed since I looked? | Revisions after the reader's last read (people: last visit; Agents: last `page read` in this Run) |
| Intent | Who has taken this? | Claims, with their conversation and pull request |

Revision attribution reads the authorized head, bounded revision history and
owed claims before releasing its database transaction. What each revision
changed against the one before it is derived from the two immutable documents
once and kept on the revision (`page_revisions.changed_blocks`), so a read
compares only revisions not derived yet. A derivation reads its bodies outside
the attribution transaction and yields between uncached section parses, so
large pages do not hold a PostgreSQL connection or block other requests for the
whole comparison; it is kept only while both bodies are still the ones
compared. A purge rewrites bodies and so forgets every derivation on the page,
which could name the removed text's headings. Markdown style alone remains no
document change. The Web reads a page's sections alone
(`GET …/awareness?scope=sections`): claims, discussions and presence reach it
live on their own.

Who wrote each passage is the same attribution read finer: every character of
a revision is owed to the first revision in the page's line that put it there,
as `git blame` walks commits (`page-blame.ts`). A revision's blame is derived
from the revision before it, comparing markdown lines and then the words of the
lines that changed, never parsed documents, so marking words bold leaves them
with whoever wrote them and moved text reads as its mover's. It is derived once
and kept on the revision (`page_revisions.blame`), batch by batch, each batch
kept only while its bodies and the blame it was derived from are still the ones
read; a purge forgets it with `changed_blocks`. The Web draws the head's blame on
the head's document through the markdown's source positions and carries it to
the live document, so what is typed since reads as being written. A paragraph
rested on shows its writers in the margin. Selecting text leaves attribution
hidden so it does not obscure the passage or compete with its discussion
controls. Revision history retains the conversations each revision came from.

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
  avatars. The page's name is the document's opening heading (§4.1), so the
  header never shows it. A document that opens without one reads "Untitled"
  in its place, as the editor's own h1; clicking it starts that heading. Hovering an
  avatar says who it is, what they are doing, where and in which
  conversation; clicking one scrolls to them. Idle people are dimmed. Beside
  the avatars: the page's conversation count (§4.4), History and Share. There
  is no ⋯ menu: each setting sits where it acts (§7). As Google Docs does with its clock icon, hovering History says
  who changed the page last and when, and a dot on it means the page changed
  since this person last read it.
- **Cursors**, as in Google Docs: a line in the person's colour with their
  name above it. The name shows while they move or type and hides about five
  seconds later, leaving a square at the caret's top; hovering the caret
  shows it again. An Agent's caret never carries its name on the text, even
  while it writes: the text holds only its colour and its blinking caret, and
  its pill beside the line (below, and §4.4) says who it is.
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
- **The top and bottom of the margin** tell what it holds out of view above
  or below (decided 2026-10-21: one source with the margin, in its style).
  Only what the margin draws and who is editing count, by where each card and
  pill is drawn: a card in the cards' style says "2 conversations below", its
  working line "claude:2 · Working", and "Ada · Editing" for a person editing
  there. Someone only reading is in the header's presence stack, and an Agent
  at rest is its card's "Idle" line; neither is told at the edges. Without a
  margin, the same card at the right edge tells of people editing out of view,
  since each Agent is its own face there. Clicking scrolls to the nearest;
  clicking an avatar in the header goes to that person.
- **Beside a wide page, an Agent at work stands in the margin** (decided
  2026-10-19): its pill, solid in its colour with its face, its name and what
  it is doing (its dots, or *thinking 12s*), level with the line it writes and
  on the cards' left edge, so the margin holds Agents and comments in one
  column that never overlaps. Under the pill is the channel it works for, on
  the pill's own columns: the comment icon under its face, the channel's name
  and newest message under its name. That channel's card is not drawn again
  while one of its Agents is at work on the page: each Agent shows once, and
  the edit it makes, not the channel, is what stands beside the text. Pressing
  the pill opens the channel right under it, on the same left edge, the pill
  staying put, with what may be done to the Agent (stop, undo, write with
  another) beside the pill. An idle Agent leaves the margin and its channel is
  a card again (§4.4). An Agent at work for a discussion is the exception: the
  discussion stays a card beside its passage, and its pill, with no channel
  under it, opens the discussion there (decided 2026-10-21). Only a solid pill
  means an Agent at work.
- **On a phone, and beside a page without room for the margin, Agents are at
  the right edge.** Each Agent on the page is its face beside the line it is at, travelling with the text as the page scrolls
  and waiting at the top or bottom of the edge, a chevron pointing to the
  line, while the line is out of view; a tap goes back to it, or, beside its
  line, says what it is doing and opens its conversation. The header's avatar
  stack names only the people. While no Agent is on the page, the bottom
  right holds the face of the Agent this person co-writes with (§4.2).
- **Headings** carry who is on the section: the people and Agents in it, and
  the Agents working in a conversation linked to it even when they do not
  have the page open, each with its state; *Update owed* where work ended
  and nobody wrote it back (§5.3); its conversation count (§4.4); and the
  freshness mark (§5.4). Who has taken a section is the Agents' to know
  (`page read`) and is not drawn for people, and a person neither claims nor
  releases (decided 2026-10-19: coordination is lock-free, and what an Agent
  intends is felt only through what it writes). Hovering a heading, or
  editing in its section, offers Discuss, Copy link and Attach at the
  heading's right edge (§6). A phone has no hover:
  the heading of the section the reader is in carries one ⋯ whose menu names
  each action, *Co-write with ‹Agent›* first.
- **No change log in the text.** As in Google Docs, who changed a section
  and when is not written under it. History says who changed each part,
  when and in which conversation (parent §4.2).
- **Margin**: the conversations about the page, each beside what it is about
  (§4.4).
- **The scrollbar** marks where others are, where discussions are and which
  sections owe an update.
- **What changed since this person last read the page** is offered to them,
  not shown: the page always opens as it is now, and the first card in the
  margin, a card of paper, (above the page where there is no margin) says how many changes there
  are since they last read it and offers *Show changes*, which shows them as a
  diff, in place. Read means seen: what has been on their screen a moment
  (1.5 s, tab in front) is read as it was then, and nothing else is. So what
  an Agent writes while they watch is read as it arrives, marked only by the
  Agent's own ink, and what it writes out of view or while they are away is
  not. How far each person has read each page is theirs and kept by the Hub
  (`data.page_reads`, `GET`/`PUT /api/spaces/:spaceId/pages/:pageId/read`),
  so it follows them across devices: the newest revision they have seen whole,
  which moves only forward, and, when they have seen only part of the page
  past it, the page as they saw it (`seen_body`): each top-level block that
  was on screen as it was then, each other block as they had last seen it
  (`pageSeenDoc`). Opening the page diffs what they saw against the document
  now, block by block and then word by word inside changed blocks. It is
  marked as a proofreader marks paper, in the app's one accent ink and never
  in a tinted box: each stretch of changed lines barred once in the left
  margin, on one line beside the text and never over a list's markers, with
  changed lines next to each other one bar and empty lines left out; inside a
  line that changed in part, new words underlined in brass and text taken out
  struck through in faint ink where it stood. Nothing is animated and nothing
  fades: once opened, the diff stays until its reader clicks *Hide changes*,
  which keeps offering it, or *Done*, which reads all of it and
  shows the page as it is, or writes on the page, which only stops marking it.
  On a phone the opened diff is walked from the right edge instead: a mark
  beside the change in front of the reader counts the changes, steps to the
  next and says *Viewed*. A first visit shows nothing as changed. Agents have no read state.
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
- **A page's name is the top-level heading its document opens with**, one
  datum kept in the document. Renaming a page is editing that line, live like
  any edit; the rename API, the CLI's `page rename` and git pushes all write
  it there. Lists, search, links and git read it from the head revision
  (`data.page_name` in SQL, `pageNameFrom` in the Hub, the same rule). A
  document that opens with anything else has no name and reads as
  "Untitled"; a page created with a name and a body that does not open with
  one gets the name written above its text.
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
- **A selection opens a comment box** (decided by Daniel 2026-10-21). A
  passage selected with the mouse opens the product's own message box, the
  caret already in it, in the margin level with the passage, as a comment
  card stands (under the passage where the page has no margin). It lies on a
  card of paper (`PaperPopover`), as the page's menus do, and the composer in
  it writes on that paper without glass of its own (decided by Daniel
  2026-10-21: the margin, and paper, for this box and the changes card); the
  passage is marked in the comment colour while it is
  written about. Typing is the comment, Enter sends it, and the caret goes
  back into the page after the passage, so writing and commenting go on
  side by side. ⌘⌥M (Ctrl+Alt+M) comments on the selection, or on the
  caret's paragraph. A selection made from the keyboard or by touch is being
  edited: it shows the selection menu, whose *Comment* opens the same box.
  Until something is typed, Backspace, copy, cut and the mark shortcuts act
  on the passage. Escape, or a click anywhere else, closes the box and the
  passage is no longer selected; a comment closed unsent comes back when the
  same passage is selected again.
  - A comment is a discussion of the passage (§4.3) whose first message is
    the comment. An Agent the comment mentions takes it at once. One that
    names nobody goes to the Agent already at work on the page, nearest the
    passage first, among those in conversations the reader can write in: its
    Instance card stands under the box, as under a conversation's composer,
    while the comment is written (decided by Daniel 2026-10-22: the existing
    Agent first, a new one only when there is none). Its Instance lives in its
    own conversation, so the comment calls it there with
    `@<name>:<n> A comment for you: channel:<discussion>`; it answers in the
    discussion, and a reply to its answer is relayed back to it (a
    cross-Channel link). With none there it goes to xMatrix (`@auto`), and an
    Agent started for it shows on its card once sent.
  - Its Agent starts at once in a private managed directory, as a
    co-writer's does, unless the comment names a repository (`repo:`,
    `pwd:`), and writes its change into the page, where its card says it is
    at work (one pill, in the card, not a second one above it).
  - People and Agents meet in a discussion alike, so there is no separate
    *Ask AI*. What acts on the whole section (copying its link) is the
    heading's, not a passage's; *Show editors* gave way to History, and
    *Claim* is not a person's to make.
- **`/` insert**: heading, list, task list, table, divider, GitHub file.
- **`[[`, `#` and `@` complete as in the composer** (and `【【`, `＃`, `＠`
  from a Chinese input method). `[[` picks a page, `[[page#` one of its
  sections, `#` a channel: the page keeps `page:<id>#<section>` /
  `channel:<id>` and draws it as a chip. `@` picks an Agent: `@<name>` stays
  in the text, like everything picked, and calls the Agent into co-writing
  as the face tap does, except that its one message is only
  `@<name> launch:force page:<id>#<section>`: nothing tells it what to write
  (decided by Daniel 2026-10-21). `#` opening a paragraph is the heading being typed.
- **Co-writing is live, as with a person** (decided 2026-10-15). A person
  starts an Agent writing the page from the page itself, typing nothing: one
  tap on the face of the Agent to write with. The Agent is then on the page
  like a colleague in a shared document, until it is stopped or the people
  leave (two minutes after the last person's connection closes, the page's
  session ends its co-writing and tells its Agent so; its Run then rests and
  sleeps as any other): its face in the header, its caret in its colour with what it is doing
  (watching, thinking, writing, waiting), and its words arriving as its harness
  writes them.
  - **Selection feedback.** Choosing an Agent immediately shows that it is
    starting, including while a new empty page is being made. The desktop
    header disables another call while that request is pending. Once sent,
    desktop feedback explains to write in the page and offers the co-writing
    conversation, where launch results can be inspected. A failed request clears
    the pending state and shows its reason on the page.
  - **At once.** The Agent a co-writing conversation calls starts in a private
    managed directory, ready the moment its process does: a launch in a
    conversation that co-writes a page, or comments on a passage of one,
    reads no repository and checks none out, unless its message names one
    (`repo:`, `pwd:`).
  - **Any Agent.** The co-writer is the Agent's own Run, whatever its harness:
    the runtime already drives every harness through a structured session
    (Claude stream-json, Codex app-server, ACP and the others), each able to
    take input, be interrupted and stream its text. Starting co-writing
    (`POST …/co-writing` with `live`) puts the Hub's `xmatrixPageCoWrite`
    instruction in the conversation, a system fact nobody takes as work;
    stopping it (`DELETE`) puts its end there. The runtime of the Agent in the
    conversation reads it and joins the page's live session as a co-writer
    (`POST …/live` with `coWrite`, a Run that may edit the page, not on a
    suggest-only page; `runtime_page_co_write.rs`). The Run HTTP gate admits
    only the live-ticket POST; the Page route proves the live Run and its
    owner’s edit access and refuses a Run joining as a raw document-sync
    client. Human readers and editors retain ordinary document sync. The connection preserves
    validated co-writing controls through its context filter, including startup
    replay; the run loop consumes them without a harness turn. A fresh Run's
    startup history read also restores the newest validated co-writing state
    before its join floor advances beyond those messages. Ordinary notices
    and caller-authored lookalikes stay context. Each turn the session sends
    reaches the run loop as a resume of that conversation, so every backend runs
    it as any turn; the harness's text, which every backend reports as
    `assistant_delta` traces (Claude with `--include-partial-messages`, in
    pieces as Codex's are), streams back with the turn's end; a new turn or the
    session's interrupt stops a turn still answering the page. Any other turn of
    the conversation is not the page's to stop: the page's request waits for it
    to end, so people typing never cut short the Agent's other work.
    Live write permission follows the connection's current edit access and the
    page's current suggestion policy throughout its lifetime, including resumed
    sockets. Losing either interrupts its turn and pauses new turns; late replies
    cannot change the document. Restoring permission sends a fresh turn with the
    changes it missed, under a new turn id.
    The session observes first CRDT text and turn outcomes without waiting for
    revision saves, including the actual quiet-turn timeout. Timings distinguish
    pending human edits, the request, runtime deltas and actual text changes;
    they are Hub observations, not browser paint. See
    [co-writing measurements](../architecture/first-space.md#measuring-live-co-writing).
  - **Writing from a conversation** (decided 2026-10-16). Any Agent in a
    conversation writes into a page the same way, as its model writes, without
    being asked: in its reply, `⟦write page:<id>⟧`, the markers below, then
    `⟦/write⟧` (`runtime_page_stream_write.rs`). The runtime reads its
    `assistant_delta` traces; once the opening marker is whole it joins the
    page's session as a co-writer that streams (`POST …/live` with `coWrite` and
    `stream`), opens a turn itself (`write`), and sends the words until
    `⟦/write⟧` or the harness's turn ends. The session asks a streaming
    co-writer nothing, and ends each of its turns with an `outcome`: what did
    not reach the page and why (a quote that is not there, someone editing what
    it wrote), which the conversation hears as its next turn; nothing when all
    of it did. The socket stays joined until the page has all its words, and a
    while after, so the next write goes straight in and a person can still take
    the last one back.
    `page edit` remains for restructuring and for suggest-only pages; its
    committed edit is typed in as described in §2.
  - **What reaches the page** is only what the Agent writes inside markers
    (`page-co-writing.ts`): `⟦after "words on the page"⟧` then markdown added
    after the block holding them, `⟦replace "words"⟧` then their new wording
    within one paragraph, `⟦note "words"⟧` then a remark shown beside its caret,
    `⟦pass⟧`. Plain text works in every harness, and streams; a tool call does
    neither. Everything else it says is seen by nobody.
  - **The session writes it** (`page-co-writer.ts`) through the same CRDT as
    everyone's typing: what it has written so far reaches its blocks in one
    transaction under its own client id at most every 80 ms (each write rebuilds
    those blocks; a harness sends its words many times a second, and Claude's
    are sent on that cadence while a reply writes into a page), so its text is
    marked as its own, and its caret follows. Its words fade in as they arrive.
    The paragraph it writes is highlighted whole in its colour: steady while it
    writes there, then held for five minutes after its last word
    (`PAGE_AGENT_INK_MS`) before it fades. Its presence names what it wrote
    (`wrote`: the changes of the last five minutes, as positions), so the
    highlight also shows for whoever opens the page meanwhile. The highlight
    identifies the paragraph without an additional bar in its left margin. It also stays
    after a streaming co-writer leaves, whose caret then rests at its last
    change as any Agent's does. Its edits commit with the
    session's idle commit, as its own, from its conversation.
  - **At a reader's pace** (decided 2026-10-16). A harness writes far faster
    than anyone reads, so while a person has the page open an Agent's words
    reach it as fast as they read along (`page-reader-pace.ts`): a word at a
    time (a Han character is one), each after the last had its reading time at
    12 characters a second (a Han character reads as two), with a breath of
    0.7 s after each sentence and line. This holds for what a co-writer streams
    and for a committed edit typed in (§2). With nobody on the page, words land
    as they come. A turn ends, with its `outcome`, once all of it is on the
    page; a turn the runtime opens meanwhile follows it. A `⟦write⟧` in a
    message (`xmatrix send`), whose sender waits on its outcome, goes in at
    once (`atOnce`).
  - **Taking it back.** A person who may edit the page takes back the Agent's
    last change from its card (Undo; `POST …/co-writing/:conversationId/undo`):
    its blocks return to what they were, and what it is still writing counts as
    its last change and stops. A change someone has edited since stays. The
    Agent hears at the next pause that it was taken back, and leaves it out
    unless asked again.
  - **When it speaks.** It reads the whole page as it joins. Afterwards, each
    time people change the page and pause (1.5 s), or after 4 s of continuous
    typing, their changes become ready to send. If an older page answer has
    still written no text after 4 s, new human input may retire it and send the
    current page and full instructions afresh. Only one consecutive refresh is
    allowed: its replacement gets to finish, and an answer already writing text
    is never refreshed this way. This limits waiting on an outdated answer without
    repeatedly cancelling a slow model as people type. Deferred changes follow
    the open answer. Ordinarily it hears the changed sections only (the
    whole page every eighth time or after more than three sections changed),
    and where each person's caret is. It keeps writing along with them, a
    sentence or two at a time right after what they just wrote, as a colleague
    typing beside them would; it passes only when there is nothing yet to
    follow, and answers from the page without tools unless the page asks it to
    look something up. Only one answer writes at a time. Claude's words reach
    the page every 80 ms while it answers.
  - **Manners.** Its own additions go straight in; it does not reword what
    others wrote but leaves a note, fixing only plain typos. It never writes in
    the paragraph a person's caret is in. When someone edits what it is writing,
    or moves their caret into it, it stops there (the runtime interrupts the
    harness), the rest of that answer is dropped, and it hears why at the next
    pause. A quote that is not on the page, or is on it more than once, writes
    nothing and is reported back to it.
- **Suggestions** wait on a suggest-only page,
  for two weeks after the last one a person reviewed
  (`GET …/pages/:pageId/suggestions`). Each is rebased onto the text as it is
  now, so what was typed meanwhile stays, and offered one change at a time, as
  Cursor offers its edits: the change in front of the reader has its words
  marked in its Agent's colour like a highlighter, and the Agent writes its new
  words out in the line, its face moving with them at their height. Tab (✓ on
  a phone, at the right edge beside the change) takes it into the page as the
  reader's own edit; Escape (✕) leaves it; the next one comes up. Once every
  change is taken or left, the suggestions stop waiting (`POST
  …/suggestions/review`, a person's, recorded as the page's
  `suggestions_reviewed_through`). History still has every suggestion.
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

- **An Agent at work comes first.** While one of a conversation's Agents is
  at work on the page, the conversation hangs under that Agent's pill beside
  the line it writes (§3.2) instead of sitting at its own anchor, and opens
  there; when the Agent goes idle, it is a card at its anchor again. A
  discussion is about the passage it was started on, so it stays at its
  passage whoever works for it (decided 2026-10-21).
- **Opening brings it into view once.** Opening a conversation scrolls the
  page to where it opens. While it stays open, its Agent going busy or idle,
  or its live session leaving and coming back, moves it in the margin but never
  scrolls the page (decided 2026-10-21).
- **Where it sits.** A discussion sits beside its passage. A conversation
  linked to a section sits beside the section's heading, and one linked to
  the whole page beside the title.
- **Which ones.** Open discussions, conversations with an Agent live in
  them, conversations with messages the reader has not read, and
  conversations active in the last day. The others have sunk (parent §3.2):
  the heading's conversation count includes them, and the conversation list
  shows them.
- **A card per conversation**, drawn as a comment is in Google Docs: the
  comment icon, then the quoted passage of a discussion (or the title of a
  conversation about a section), the last message with its author's avatar, name and age, the
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
  messages scroll. Its head shows the passage once (the conversation's name
  too, only once it says something else); the messages are only what people
  and Agents wrote, so a discussion's first message does not quote the
  passage again. Messages read as comments (a small avatar, name and time
  on one line, the text below) and a one-line reply box closes it; a thread
  with nothing said yet is just its head and that box, as a new comment is.
  The card's head carries resolve, *Open in Conversations* and close. The other
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
- **Starting one.** A comment on a selection (§4.2) creates the conversation
  already linked there with the comment as its first message, and the page
  stays in front of the reader; *Discuss* on a heading creates it and opens
  it beside the page with its composer focused.
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

The page tree's Agent activity and page conversation lists use lock-free,
independent `single_read` statements on one request session, including their
access checks and conversation descriptions. Each statement retains its
placement fence and READ COMMITTED snapshot. A lost response destroys that
checkout and retries the read once on a fresh connection; repeated loss and
answered SQL failures propagate. These reads need no enclosing BEGIN/COMMIT.

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
never stored as a queue: it is read from the event's own record, which notes
when it was written back.

| Event | Section | Derived from |
|---|---|---|
| A pull request that names the section is merged | The section it names | The record of its work, made at the merge whether or not anyone claimed the section |
| A claim is released or lapses | The claimed section | The claim |
| An Automation occurrence that starts an Agent ends, or never starts, without the section written | Its section | The claim the occurrence opened (§6.1) |
| A live reference in the section changes state (§5.4) | That section | The reference |

An owed update is settled by the next edit to its section, or by the Run
saying nothing there changed (`xmatrix page done`, which records it on that
conversation's ended claims). The edit records the write-back on the claims of
the sections it changes, so a debt never returns once the section's last change
is old. A release ends a lease, not work: a section its holder's conversation
edited while holding the claim was written back before the release and owes
nothing; an edit from another conversation does not settle a claim still held.
Only a release that leaves a debt runs the section's `owed` Automations. A
section taken off the page owes nothing. Anything older than a week stops
counting.

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
  Space's Schedules list every Automation, with *Delete*. The edit says so
  when it happens: its result names each Automation it detached or resumed
  and each top section it removed, `page edit` prints a line for each, and
  people on the page see a notice. A resumed Automation that never ran gets
  its first delay again, at most one interval.
- **Each occurrence works in a fresh conversation.** The Automation has a
  conversation of its own, created with it, whose authority times it; nothing
  is posted there. Each occurrence opens a new conversation as the
  Automation's author, linked to its section and named for the Automation and
  the occurrence's time, posts its message there and writes back to the
  section (§5.2). An occurrence never inherits an earlier one's chatter: what
  carries over lives on the page. The chip and Schedules open the last
  occurrence's conversation. An Automation with connector or GitHub event
  triggers uses closed occurrence conversations even when its Page is readable
  to the whole Space. Any captured trigger event also requires a closed
  conversation, including an `owed` event that can name a private pull request,
  even if its trigger configuration has since changed. A retry that
  finds an older open conversation refuses to append those private details.
- **An occurrence that starts an Agent holds its section.** It claims the
  section for its conversation, shown under the Automation's name. The Run
  takes that claim over when it claims the section, and writing the section
  settles it. A Run that never starts, or ends without writing, leaves the
  claim to lapse, and the section owes an update (§5.2) that names the
  occurrence's conversation. A section someone else is on is left to them.
- **An edit can set the next run.** The cadence counts from it, so
  Automations on the same cadence need not run in the same minute
  (`xmatrix page automation edit --next <UTC time>`).
- **Nothing runs unanchored.** An Automation is created only in a page
  section: from the page, `xmatrix page automation create` or a Management
  Agent acting through the page. The Space's Schedules only lists and
  manages them. There is no message macro for it: saying "audit
  this every 12 hours" in a conversation is an ordinary request an Agent acts
  on by creating the Automation where it belongs.

### 6.2 Triggers

Every Automation has a cadence, and a page's Automation may add event
triggers. Whoever can manage it can also run a running Automation now
(Schedules' *Run now*, `xmatrix page automation run`): its next occurrence is
due at once, as its author, and its cadence continues from that run. A trigger never queues work; it makes the next occurrence due now.
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
  owner can; there is no birth-conversation restriction. Pending trigger
  summaries and URLs additionally require the reader (or the Agent's current
  owner) to be a Space owner, admin or member. Viewers and participants still
  see the schedule, without connected-app event details; the stored events
  are preserved for authorized readers and delivery. Author-entered trigger
  configuration, including repository names, follows the Page's visibility.
  An authorized author or Agent can also publish event content into Page prose;
  the automatic event projection does not restrict those explicit Page writes.
- **Create, edit, pause, resume, move, delete**: anyone who can edit the page.
  On a suggest-only page an Agent's change is refused and it asks a person,
  because an Automation is not text a person can review as a suggestion.
- **Authority does not change hands in place.** An Automation runs with its
  author's Machines, Agents and name. Pause, resume, move and delete keep the
  author. An edit by anyone else atomically replaces it with a new Automation
  whose author is the editor (an Agent's author is its owner), and the
  reference in the body is rewritten to the new id in the same page revision.
  Every change is a page revision, so History shows who changed which
  Automation, in which conversation. An Agent's reference edits are attributed
  to its actual Run conversation. The Automation's timer conversation remains
  independently private; authoring does not grant the Agent access to it.

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
  sections. The contract migration moved the existing ones: each
  one's reference was appended to the page its conversation was last linked
  to, or else its Space's first root page.

### 6.5 A GitHub file is embedded by reference

A section that needs a repository file, a prompt or a runbook, shows it in
place without copying it:

```
## Startup prompt
[bootstrap.md](xmatrix:github-file/LambdaLabsHQ/xmatrix/docs/prompts/bootstrap.md)
```

- **The link is the embed.** `xmatrix:github-file/<owner>/<repo>/<path>` names
  one file on the repository's default branch; `?ref=<branch, tag or commit>`
  pins it. The `/` menu's *GitHub file* turns a pasted GitHub file link into
  one. A link that does not parse stays an ordinary link.
- **The editor draws the file below the paragraph** that holds the link:
  markdown as the page draws its own text, read only, with its links pointing
  where they do on GitHub; any other text file as code; a binary file, or one
  too large for GitHub to inline, as a link. It reads on the page's paper,
  aligned with the surrounding text, between two hairlines. The repository,
  path, revision and GitHub link form a small source citation below the text.
  A long file starts folded, with its source still visible.
- **It is read through, never stored.** `GET
  /api/spaces/:spaceId/pages/:pageId/github-file?href=` reads the file as the
  caller: only a Space member who may read the page, only a file the page's
  head revision references, and only through the Space's GitHub connection,
  with a token that reads that one repository's contents. The Hub keeps a
  read for a minute per connection; the page keeps nothing. A link the page
  has only just gained is shown once the page session commits it.
- **Each refusal names what is missing**: no GitHub connection, a repository
  the connection does not reach, a file that is not there, a folder.
- **A published page shows the link, not the file**, so a public reader never
  sees a private repository's contents. Agents read the link in `page read`
  and the file in their checkout.
- **A directory is never mounted.** Mounting a repository's `docs/` into the
  page tree assumed one layout and was removed (parent §3); an embed is one
  file a page chose to show.

### 6.6 Pasted images and videos

Pasting or dropping an image (PNG, JPEG, GIF, WebP, AVIF) or a video (MP4,
WebM, QuickTime) into the editor puts it in the text as a markdown image,
`![name](xmatrix:page-media/<sha-256>.<ext>)`, and uploads the file.

- **The bytes are the Space's private content.** The editor uploads through
  the private content API in the Space's scope and commits a content
  reference `page-media:<pageId>:<sha-256>` (owner kind `page_media`), so
  the file is kept while the page holds it. The page text keeps only the
  reference; the extension names the type, and only these types are served
  (never markup such as SVG).
- **The writer sees it at once.** The file is drawn from the writer's own
  copy while it uploads, with its progress; a file that does not upload
  leaves the text again and the editor says why.
- **It is read as the page.** `GET /api/spaces/:spaceId/pages/:pageId/media/:file`
  serves the file to whoever may read the page, when the page's head text
  shows it or it was pasted into this page and not saved yet, and only when
  the Space holds it as page media — a page can never name another Space's
  file into view by its hash. A `Range` request is answered in part, so a
  video plays from where it is sought. The web reads it through its proxy
  with the session cookie, so an image or video element loads it directly.
- **A published page shows its pasted files**: `GET
  /api/public/spaces/:spaceId/pages/:pageId/media/:file` serves what the
  public page's saved text shows, to anyone.
- **Images show inline; a video as a player** with its own controls, in the
  editor, the page's preview and the public page alike.
- **An Agent sees them as it sees Channel images, where they stand.**
  `xmatrix page read` saves each image the page shows on the machine, through
  the same download and cache as `channel history`, at
  `…/attachment-cache/page-media/<sha-256>.<ext>`, and names it by that path
  in the text in place of its reference, so the harness's own file tool opens
  it. A video, or an image that could not be saved, keeps its reference.
  Nothing is pushed into the Agent's context: an image costs only when the
  Agent opens it.
- **Writing maps it back and refuses local images.** Every way an Agent writes
  into a page — `page edit`, `page create`, `⟦write⟧` in a reply or a message,
  live co-writing — passes its text through the CLI's `page_media` mapping:
  a path ending in `attachment-cache/page-media/<sha-256>.<ext>`, read on any
  machine, is the page's reference again; an image of any other local file
  (a path, `~`, a drive, a share, `file:`) is not written. `page edit` and
  `page create` refuse the whole text, except for images the page already had
  at the edit's base revision; a stream holds each image until it is whole
  and leaves a local one out, and the Agent is told. The editor does not take
  `file:` or `blob:` images from pasted HTML either.

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
| Settings: project governance | Open participation on the Space in Team; the governance page in Share ("Space rules": only owners and admins edit it, every Agent follows it), both for Space owners and admins |
| The move to pages | A notice on the page while an Agent's draft waits for an owner or admin |

A phone shows the same things on the page itself: avatars and the
conversation count in the header, headings and bubbles in the text,
and Share and History in the page's top bar.

Creating a page works as in Notion: the desktop list's + and Ctrl/⌘+N, the
phone's FAB, the empty list and a parent row's sub-page + each open a new page
at once, with no dialog or browser prompt, on its title, on a phone as on a
desktop. The title is the document's first line, drawn as its h1 with an
"Untitled" placeholder; there is no title field, so a new page looks exactly
like any page. A new page is an ordinary page on screen, with the same editor
and header, Co-write included (§4.2), and there is no draft: it is made by its
first write, like copy-on-write. Until then its live document exists only in
the browser, and one opened and left empty is not kept anywhere. The first
write is a keystroke (letters typed on the first line make it the opening
heading) or calling an Agent. It makes the page under the chosen parent from that document
as it stands. The Hub keeps the document's markdown as revision 1 and starts
the page's live session from the same Yjs document, so the editor joins that
session without reloading and goes on syncing what is typed meanwhile. Enter after
the name goes on into the text; left without one the page stays unnamed. Until it is made, the header
shows only Co-write. A failed make says so on the page, and the next write
tries again.

## 8. Build order

Shipped:

1. Editor engine and schema with the round-trip test; Agent edits through the
   structural update; `/` and the selection menu (v0.16.464). The formatting
   toolbar from that pass was removed: the caret's line shows Typora markers,
   and table controls show only inside a table.
2. Awareness: per-block aggregation, `page read` front matter; Now bar,
   heading avatars, follow, section footer (v0.16.467); `page read --since`
   (v0.16.470).
3. Anchored discussions with resolve (v0.16.470; Ask AI on a selection
   was folded into Discuss on 2026-10-19).
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
8. Live co-writing (§4.2) with any Agent: the session's engine (#529), the
   runtime's bridge with start and stop and the caret's status and note
   (#531, v1.0.427), then its words fading in and Undo; an Agent's edit while
   it co-writes goes straight in, and suggestions are a suggest-only page's.

Open:

- Automations as live references in their section, with page access, event
  triggers and the removal of Channel-scoped Automations (§6).
- Change events pushed to a Run when a block it read or claimed changes
  (§3.1), and "changes since your last visit" for people.
- Live references and freshness for GitHub issues and pull requests (§5.4).
- Images.
