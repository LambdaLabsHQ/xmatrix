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
  revision and the last editor. It does not say who is on which block, which
  Agent is working on which block in which conversation, how old a statement
  is, or that a block changed after the Agent read it; it finds out only when
  its edit conflicts.
- **People are half blind too.** They see cursors and header avatars, but not
  what an Agent intends, how fresh a statement is, or what changed since they
  last looked.
- **The editor is a markdown code editor.** CodeMirror with live preview shows
  `#` and `**` on the lines being edited, and has no toolbar, no selection
  menu and no `/` insert.
- **The page's surroundings are a flat list.** Presence, links, mounts,
  publishing and governance share one column; creating a page or a mount uses
  `window.prompt`; history is raw text without a diff.
- **Pages are kept current late, or not at all.** The write-back contract
  (parent §6.1) must apply during work as well as before the Agent stops. A
  merged pull request, a release or a finished Automation changes how things
  stand without anyone being asked to update the page.
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
   release, CI run, schedule or repository file is embedded as a live
   reference that renders its current state. Prose holds what has no other
   authority.
5. **Markdown stays the Agent's medium and the durable format.** Revisions,
   git and Agent edits remain markdown; the editor is a view over it.

A whole-document Agent edit is authorized and committed before it is shown.
It then reaches the live document whole, in one CRDT transaction under the
Agent's awareness id: readers see exactly what was committed, at the moment it
was committed (decided by Daniel 2026-10-25). It is never replayed word by word
or animated as if it were being typed: a page that shows part of an edit the
head already holds misstates what the Agent did. An Agent that wants to be
seen writing writes into the page as it writes (§4.2, `⟦write⟧`), and only
those words, as its model produces them, appear progressively.

- **Smallest update.** The transaction is the smallest structural update from
  the live document to the edit, so people typing anywhere meanwhile, even in
  the same line, keep their words around it.
- **Marked as its own.** The Agent's caret rests where its change ends, and the
  lines it changed stay highlighted in its colour while fresh (§4.2), so a
  reader sees what it changed without watching it arrive.

Agents that read one revision and change neighbouring lines both get their
edit: whole lines merge first, then the words of lines that touch. Commits are
announced in commit order, after their text is in the live document.

Text that differs from the committed page while no person's edit is pending
is no person's, so a restored session reads as its committed page. A session
kept by an earlier version, which typed committed edits in, may still hold the
words it had left to type; restoring it puts them in at once
(`page-stored-typing.ts`), around people's pending edits, without another
commit.

## 3. Awareness

Each block's awareness has three layers.

| Layer | Question | Sources |
|---|---|---|
| Facts | Is this still true? | Revision attribution (who, which conversation, when); resolved live references |
| Presence | Who is here, doing what? | Editor awareness of people and Agents; live Runs in linked conversations with their invocation state; each Agent's intent line |
| Change | What changed since I looked? | Revisions after the reader's last read (people: last visit; Agents: last `page read` in this Run) |

Revision attribution reads the authorized head and bounded revision history
before releasing its database transaction. What each revision changed against
the one before it is derived from the two immutable documents once and kept on
the revision (`page_revisions.changed_blocks`), so a read compares only
revisions not derived yet. A derivation reads its bodies outside
the attribution transaction and yields between uncached section parses, so
large pages do not hold a PostgreSQL connection or block other requests for the
whole comparison; it is kept only while both bodies are still the ones
compared. A purge rewrites bodies and so forgets every derivation on the page,
which could name the removed text's headings. Markdown style alone remains no
document change. The Web reads a page's sections alone
(`GET …/awareness?scope=sections`): discussions and presence reach it live on
their own.

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
  doing: the title of the conversation its Run is in plus its invocation
  state. For example `claude:3 · Working · adding Phase 5 to Next steps`.
- **Permissions.** Presence in a conversation the reader cannot read shows
  "an Agent is working here" with no title (parent §7).

### 3.1 How an Agent perceives it

`xmatrix page read` puts awareness in the front matter, never in the body,
so an Agent's edit cannot write it back:

```
---
pageId: 227ecdfb-…
revision: 12
blocks:
  status: {updated: "3h ago by claude:1 in \"Phase 4 release\""}
  next-steps:
    working: claude:3 Working in "Migrate Lambda Labs"
    viewing: Yiming Hu
live:
  "github:pr/LambdaLabsHQ/xmatrix#2963": merged · released v0.16.444
---
```

- `page read --since <revision>` returns only what changed, as a diff per
  block with its authors and conversations.
- **Change events.** A Run that read, linked or edited a block receives an
  event at its next turn boundary when someone else changes that block: who,
  in which conversation, and the diff. It learns of overlap before its edit
  conflicts, not after.
- **Nothing is locked.** `page read` shows who is on each block and which
  Agents work in its conversations, so an Agent sees overlapping work before
  it starts and talks to them there.

### 3.2 How a person perceives it

Everything a person perceives about a page is drawn on the page, at the place
it concerns. There is no panel of lists beside the document: a list repeats
what the document already shows, and it separates each fact from the text the
fact is about.

- **Header** (decided by Daniel 2026-10-23): History and Share, and
  nothing else that is always there. It names no one, keeps no conversation
  count and offers no Co-write: who is where shows in the text, the
  conversations stand beside what they are about, and an Agent is called
  with `@` in the text. It speaks of saving only when something is wrong:
  edits held while the session is away (*Offline*), a session still
  connecting after two seconds, and a page the reader may only read. The
  page's name is the document's opening heading (§4.1), so the header never
  shows it. A document that opens without one reads "Untitled" in its place,
  as the editor's own h1; clicking it starts that heading. There is no ⋯
  menu: each setting sits where it acts (§7). As Google Docs does with its
  clock icon, hovering History says who changed the page last and when, and
  a dot on it means the page changed since this person last read it.
- **Byline** (decided by Daniel 2026-10-23): under the title, as a column
  names its writers, each author of the page by face and name, a hairline
  between them, and no other words. An author is whoever has words in the
  page now, from its blame (most words first); someone whose words were all
  taken out is no longer one. Pointing at an author marks their words in the
  text, and an author changing the page now breathes. The title keeps the
  byline's room in the preview as in the editor, so nothing moves when the
  authors arrive.
  The saved blame is carried to the live document: edits before the next
  revision immediately move each author's highlighted words and remove
  authors whose words have gone. The byline retains the pointed-at identity,
  never positions from an earlier document; live edits need no new blame read.
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
  or below. Each is one quiet line on paper, with an arrow, conversation count
  and explicitly labelled unread-message count plus a red dot (Daniel approved
  2026-10-26). Cards stay clear of these lines; neither line is a floating card.
  Only what the margin draws and who is editing count, by where each card and
  pill is drawn. Working Agents and editing people are named on the same line;
  readers and idle Agents do not add an edge notification. Without a margin,
  the same line at the right edge tells of people editing out of view, since
  each Agent is its own face there. Clicking scrolls to the nearest.
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
  line, says what it is doing and opens its conversation. While no Agent is on the page, the bottom
  right holds the face of the Agent this person co-writes with (§4.2).
- **Headings** carry who is on the section: the people and Agents in it, and
  the Agents working in a conversation linked to it even when they do not
  have the page open, each with its state, and its conversation count
  (§4.4). Nobody holds a section (decided 2026-10-19: coordination is
  lock-free, and what an Agent intends is felt only through what it writes;
  decided by Daniel 2026-10-25: nothing is claimed). A heading carries no row
  of tools (removed 2026-10-23 at Daniel's request): discussion starts from a
  selection (§4.2), and Automations are written into the section (§6.1). On
  a phone the heading of the section the reader is in carries one ⋯ whose
  menu offers *Co-write with ‹Agent›*.
- **No change log in the text.** As in Google Docs, who changed a section
  and when is not written under it. History says who changed each part,
  when and in which conversation (parent §4.2).
- **Margin**: the conversations about the page, each beside what it is about
  (§4.4).
- **The scrollbar** marks where others and live, unresolved conversations are
  anchored in the document. Unread conversations have red marks; the current
  viewport is outlined. Each mark is a keyboard-accessible button that scrolls
  to its document anchor, independently of displaced margin cards.
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
  Clicking or tapping a link's label opens it in a new tab, including bare
  URLs and Markdown links, while the page remains editable. Dragging across
  a link selects its text without opening it. Web, email and telephone links
  can open; other URL schemes are blocked. Clicking a link's visible
  destination edits the address.
- **What the caret shows never moves the text under the pointer.** Markers
  stay as they were while the button is down and follow the caret once it is
  up; if the markers it leaves took lines, the page scrolls by that much so
  the selection stays under the pointer. A code fence shows in its block's
  corner, not on a line of its own.
- **Table controls** appear only while the cursor is in a table, floating
  above it rather than taking room in the page.
- **A selection offers a comment; a click opens it** (decided by Daniel
  2026-11-01, replacing the 2026-10-21 box that opened on a mouse selection:
  a selection may be for editing, and the box took the focus from it). Any
  selection, by mouse, keyboard or touch, keeps the caret in the page and
  shows the selection menu; its *Comment* opens the product's own message box,
  the caret then in it, in the margin level with the passage, as a comment
  card stands (under the passage where the page has no margin). It lies on a
  card of paper (`PaperPopover`), as the page's menus do, and the composer in
  it writes on that paper without glass of its own (decided by Daniel
  2026-10-21: the margin, and paper, for this box and the changes card); the
  passage is marked in the comment colour while it is
  written about. Typing is the comment, Enter sends it, and the caret goes
  back into the page after the passage, so writing and commenting go on
  side by side. ⌘⌥M (Ctrl+Alt+M) opens the same box on the selection, or on
  the caret's paragraph. Escape, or a click anywhere else, closes the box and the
  passage is no longer selected; a comment closed unsent comes back when the
  same passage is selected again.
  - A comment continues the existing conversation about the passage when
    possible (decided by Daniel 2026-10-28). A live Instance it names
    (`@claude:2`, or `@claude` for the selected live Agent) takes it as the Agent
    at work on the page does, below; any other Agent the comment mentions starts
    on it at once. One that
    names nobody goes to the Agent already at work on the page, nearest the
    passage first, among those in conversations the reader can write in: its
    Instance card stands under the box, as under a conversation's composer,
    while the comment is written (decided by Daniel 2026-10-22: the existing
    Agent first, a new one only when there is none). The comment is sent directly
    into that Instance's own conversation, addressed to it by its exact name,
    with the passage and a link back. That conversation is linked to the passage;
    no new conversation or Instance is created. With no live Agent, the comment
    continues the section's latest editing conversation when exactly one is
    available to the reader. With neither destination it starts a discussion
    (§4.3), whose first message gives it to xMatrix (`@auto`); an Agent started
    for it shows on its card once sent. Hub authorization still gates every
    message and link; inaccessible or ambiguous editing provenance selects no
    conversation.
    A destination outside the loaded Channel catalog is resolved by its exact
    id through the ordinary authorized catalog read before sending. A failed or
    unavailable lookup reports an error and creates no replacement discussion.
  - An Agent newly called for a comment starts at once in a private managed directory, as a
    co-writer's does, unless the comment names a repository (`repo:`,
    `pwd:`), and writes its change into the page, where its card says it is
    at work (one pill, in the card, not a second one above it).
  - People and Agents meet in a discussion alike, so there is no separate
    *Ask AI*. What acts on the whole section (copying its link) is the
    heading's, not a passage's; *Show editors* gave way to History.
- **`/` insert**: heading, list, task list, table, divider, GitHub file.
- **`[[`, `#` and `@` complete as in the composer** (and `【【`, `＃`, `＠`
  from a Chinese input method). `[[` picks a page, `[[page#` one of its
  sections, `#` a channel: the page keeps `page:<id>#<section>` /
  `channel:<id>` and draws it as a chip. `@` picks an Agent: `@<name>` stays
  in the text, like everything picked, and calls the Agent into co-writing
  as the face tap does, except that its one message is only
  `@<name> launch:force page:<id>#<section>`: nothing tells it what to write
  (decided by Daniel 2026-10-21). The menu lists first the live Instances
  in this page's conversations (`claude:2`, beside the section each works on;
  Instances at work only on other pages are not offered, decided by Daniel
  2026-10-26): picking one starts no conversation or Instance; its own
  conversation is linked to the page and co-writes it, and it is told there
  `@claude:2 page:<id>#<section>` (decided by Daniel 2026-10-26). The harnesses
  follow, each a new Instance. `#` opening a paragraph is the heading being typed.
- **Co-writing is live, as with a person** (decided 2026-10-15). A person
  starts an Agent writing the page from the page itself, typing nothing: one
  tap on the face of the Agent to write with. The Agent is then on the page
  like a colleague in a shared document, until the person stops it (decided
  by Daniel 2026-10-26). A dropped connection does not end it, and neither
  does the person leaving. When people type and that Agent is not on the page
  — it slept, or an older Hub had ended co-writing because they seemed to
  have left — the page wakes it, and it reads the page as it joins. Its Run
  may still rest after a day of quiet; the next typing wakes it. Its caret
  stays in its colour with what it is doing (watching, thinking, writing,
  waiting), and its words arrive as its harness writes them.
  - **Selection feedback.** A call disables another while its request is
    pending. Launch results and the conversation stay in
    the existing margin card (or the page's conversation list in a narrow
    window); no banner is inserted above the document. The phone's existing
    Agent button shows the called Agent until it appears on the page. A failed
    request clears the pending state and shows its reason on the page.
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
    before its join floor advances beyond those messages. For a fresh launch
    with a message, the runtime joins the page before its first model turn.
    With `page_cowrite_input_v1`, it supplies the ordinary launch input on the
    live ticket. The Page combines it with its current document and writing
    protocol once, marking that first request `initial: true`. The Host submits
    those complete bytes as one input with the original execution attribution;
    subsequent requests do not replay the invitation. A slow connection cannot
    start an ordinary invitation or bootstrap-only model turn. The Host's
    transport startup budget is two minutes; closure or expiry fails explicitly
    before model submission. The one-use input is not serialized into the
    socket attachment or replayed after hibernation. Pending live tickets are
    capped at 64 per Page and expire after one minute; each initial input is
    limited to 256 KiB, so failed connections cannot retain unbounded input.
    Older Hub connections keep
    the legacy ten-second wait and local combination. Ordinary notices
    and caller-authored lookalikes stay context. Each later turn the session sends
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
    `⟦/write⟧`. With `page_assistant_output_v1`, the runtime forwards normalized
    assistant text through an independent, bounded delivery channel
    (`POST /api/channels/:id/page-output`). Tool results, reasoning and stored
    diagnostic traces are excluded. Local attachment paths are resolved by the
    Host; the Hub's Page-domain parser interprets the outer markers and opens
    the Page write. Old Hubs retain `runtime_page_stream_write.rs` and the
    `POST …/live` streaming socket; a Run never switches to that fallback after
    a new-protocol delivery failure.

    Each model output has a stream id, sequence and confirmed character cursor.
    A transport retry resends the same bounded frame; the Page records its
    receipt with the document before acknowledging it. Page authorization is
    checked even for duplicate deliveries. Limits refuse input and return a
    retry delay; unaccepted text stays at the Host, never in a Hub playback
    buffer. New writes are applied synchronously before their receipt is saved.
    An ambiguous Page RPC is retried with its original operation id. If the
    Page's live parser and anchors have been lost, the result is `unknown` and
    the Host stops that output; it never recreates the action or reruns the
    model. Cancellation durably fences subsequent delivery at both the router
    and the Page, and stops the bound live writer without flushing pending text. Streams expire after
    thirty minutes, with bounded receipts and a bounded Host queue; losing a
    Host process does not promise exactly-once execution or replay its transcript.

    The session asks a streaming
    co-writer nothing, and ends each of its turns with an `outcome`: what did
    not reach the page and why (a quote that is not there, someone editing what
    it wrote), which the conversation hears as its next turn; nothing when all
    of it did. Its live writer retains the last change for undo while it lives.
    With `page_cowrite_output_v1`, session-initiated co-writing uses this same
    output transport. Its input/control socket requests `acknowledged: true`;
    the Page attaches its opaque connection id as `outputSession` to each
    turn. The Host carries that exact page/session/turn binding on every frame,
    including an empty answer's end. The Page adopts its existing writer,
    preserving anchors, human-edit interrupts and undo; it does not create a
    second writer or accept output on the input socket. The first internal
    operation is an explicit `answer`, so a Page running an older protocol
    rejects it instead of opening a conversation writer. A reconnect, lost
    live writer or changed Run cannot adopt an old answer even if a turn
    number repeats. Older Hubs keep the legacy socket output path; a negotiated
    Run never silently falls back after a transport failure.
    `page edit` remains for restructuring and for suggest-only pages; its
    committed edit reaches the page whole, as described in §2.
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
    marked as its own, and its caret follows. Its words appear as they arrive,
    with no fade or other entrance.
    The paragraph it writes is highlighted whole in its colour: steady while it
    writes there, then held for five minutes after its last word
    (`PAGE_AGENT_INK_MS`) before it fades. Its presence names what it wrote
    (`wrote`: the changes of the last five minutes, as positions), so the
    highlight also shows for whoever opens the page meanwhile. The highlight
    identifies the paragraph without an additional bar in its left margin. It also stays
    after a streaming co-writer leaves, whose caret then rests at its last
    change as any Agent's does. Its edits commit with the
    session's idle commit, as its own, from its conversation.
  - **As it is sent, nothing held back** (decided by Daniel 2026-10-25,
    replacing the reader's pace of 2026-10-16). The page holds exactly what the
    Agent has sent: the Hub keeps no buffer of words already written to show
    them later at a reading pace, and draws no entrance animation over them.
    What the session has taken is what everyone sees. A turn ends, with its
    `outcome`, as soon as all of it is sent and on the page; a turn the runtime
    opens meanwhile follows it. A pace, where there is one, belongs to what the
    Agent may send, never to what the page shows of what it sent.
  - **At a rate, as an API limits its callers** (decided by Daniel
    2026-10-25). The session takes an Agent's live words at
    `PAGE_CO_WRITE_RATE`: a runtime sends at most 10 characters at a time, 20
    a second on average (`PageWriteOutbox` in `page_co_write.rs`), each write
    saying where in the turn it starts (`paced.at`); an image's markdown goes
    whole. The session keeps an allowance of 20 characters, refilled at the
    same rate, so jitter between writes sent in time is never refused. A write
    past the allowance, or one that does not follow on from what the turn has
    taken, is refused whole, as an HTTP 429 refuses: the session takes nothing
    of it and answers `limited` with where to go on from and when
    (`retryAfterMs`); the runtime sends the turn again from there. A turn's end
    says how many characters were sent and is refused the same way until the
    session has them all. What the model has written and the runtime has not
    sent yet is still the Agent's own, as words a person has thought of and
    not typed yet: the page holds exactly what was sent and taken, the moment
    it is taken. A message's `⟦write⟧` (`xmatrix send`, `atOnce`) is whole
    when it is sent, so it is taken whole and not paced. A runtime that does
    not pace (one released before the rate) is taken as it sends.
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
- **The conversation list.** The page toolbar's comment icon and total count,
  or a heading's count, opens every conversation linked to the page, grouped
  by section. All / Open / Resolved filters include quiet conversations and
  resolved discussions; open discussions resolve from it too. The toolbar dot
  indicates unread conversations. This entry is available on phones too.
- **Starting one.** A comment on a selection (§4.2) creates the conversation
  already linked there with the comment as its first message, and the page
  stays in front of the reader.
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
describes. The Run whose work changes what a page says writes it back as part
of that work, when the state changes, not at the end of its Run or in a
periodic sweep. Nothing keeps a ledger of what is left to write: no section
is claimed and none owes an update (decided by Daniel 2026-10-25).

### 5.1 Less to maintain

- **Live references keep themselves current** (§2.4): a pull request's state,
  a release version, a CI result or a schedule's next run is never restated
  in prose, so it cannot go stale.
- **Presence is not page text.** Who is on what is drawn from presence and
  live Runs (§3); nobody edits a page to say they started or stopped.
- **Pages stay short** (parent §6.2), so updating one is a small edit.

### 5.2 Who writes it back

1. **The Run that did the work**, at the moment the state changes. Its Run
   prompt asks it to update the page whenever its work changes what the page
   says, and otherwise to say the page is unchanged. A pull request a Run
   opens reports back to its conversation, so the Run hears of the merge
   while it is live and writes the section with `xmatrix page edit`.
2. **The section's Automation**, where it has one: it keeps the section true
   on its cadence and on the events it triggers on (§6).

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
  write-back (§5).
- **Launch targets** (parent §3.1).

### 6.1 An Automation is a line of its section

An Automation is a standing rule, "when this happens, have an Agent do that,
so that what this section says stays true". A conversation is linear and
sinks when idle, so an Automation never belongs to one; it belongs to the
section it keeps true, and it is a line of that section, written as Obsidian
Tasks writes a recurring or scheduled task (decided by Daniel 2026-10-31):

```
## 1. Architecture: no bloat
- [ ] @auto repo:acme/api audit the code for bloat; record it here 🔁 every 12 hours
- [ ] @codex review each merge 🔁 every day, on merged:acme/api@main
- [ ] Remind @Yiming to renew the domain ⏳ 2026-11-03 09:00 +08:00
- [x] Remind Daniel about the quarterly tax ⏳ 2026-10-30 09:00 +08:00 ✅ 2026-10-30
- [-] Sweep Sentry 🔁 every week
```

- **The line is what it is.** A task with `🔁` or `⏳` outside code is a
  schedule; its description, before the first of them, is what each
  occurrence posts. `🔁` takes a cadence (`every 12 hours`, `every day`,
  `every 2 weeks`, `every 12h`) and, after commas, the events that also make
  it due (§6.2); `⏳` alone runs it once at that time, written with its
  offset, and with `🔁` sets when its first occurrence runs. `[ ]` runs, `[-]`
  (Obsidian's cancelled) pauses, `[x]` is done; deleting the line deletes it,
  and moving it to another section moves it. People and Agents edit it like
  any other text; nothing else stores what it is. `@` in the line says who
  runs it, as in a message; `/` stays a command; neither is reused for time.
- **The editor quiets its timing** (from `🔁` or `⏳` on) and draws after
  the line, from the Automation it is, when it runs next; clicking that opens
  the conversation its last occurrence ran in. A line that cannot run as
  written says why there instead (a cadence out of bounds, a time without its
  offset, an event in a repository the Space's GitHub connection does not
  cover), and `page edit` prints it. `page read` lists the page's schedules
  under `automations:`.
- **Each revision syncs its lines.** After a revision moves the page's head,
  the Hub makes the page's Automations what its lines say, as that revision's
  author (an Agent's author is its owner): a new line creates one, a changed
  line changes it, a removed line deletes it, `[-]` or `[x]` stops it. Each
  Automation keeps the line it was synced from; the next sync knows it by that
  line, then by its instruction, then by its place in its section. An
  occurrence runs only while its line is still running in the head, so a sync
  that has not landed never runs what the page no longer says.
- **A delivered reminder is checked off**: the Hub writes `[x] … ✅ <day>` into
  its line, as Obsidian does for a done task. Giving it a new time and `[ ]`
  arms it again.
- **Each occurrence works in a fresh conversation.** Each occurrence opens a
  new conversation as the Automation's author, linked to its section and
  named for the Automation and the occurrence's time, posts its message there
  and writes back to the section (§5). An occurrence never inherits an earlier
  one's chatter: what carries over lives on the page. An Automation with
  connector or GitHub event triggers uses closed occurrence conversations even
  when its Page is readable to the whole Space. Any captured trigger event
  also requires a closed conversation, even if its trigger configuration has
  since changed. A retry that finds an older open conversation refuses to
  append those private details.
- **Nothing runs unanchored.** An Automation exists only as a page line. The
  Space's Schedules only lists them and runs, pauses, resumes or deletes one
  by changing its line. There is no message macro: saying "audit this every
  12 hours" in a conversation is an ordinary request an Agent acts on by
  writing the line where it belongs.

### 6.2 Triggers

Every Automation has a cadence, and a page's Automation may add event
triggers, or instead run once: a reminder. Whoever can manage it can also run a running Automation now
(Schedules' *Run now*, `xmatrix page automation run`): its next occurrence is
due at once, as its author, and its cadence continues from that run. A trigger never queues work; it makes the next occurrence due now.
A GitHub trigger records the installation of the Space's GitHub connection
that covers its repository, and fires only on that installation's events
while the Space is still connected to it.

| Trigger | Fires when |
|---|---|
| `🔁 every <interval>` | The interval has passed since the last occurrence (15 minutes to 30 days) |
| `, on merged:<owner/repo>[@branch][:path,…]` | A pull request is merged into the branch (default: the default branch), touching one of the paths if any are given |
| `, on ci-failed:<owner/repo>[@branch][:workflow]` | A workflow run on the branch concludes with failure |
| `, on <app>:<event\|*>[:<source>]` | A connected app delivers that event (`connector-platform.md` §3.4) |

A reminder (`⏳ <time with its offset>` without `🔁`)
is for a dated commitment the page records: a booking, a deadline, a renewal.
It runs once at its time, within a year, in its own conversation like any
occurrence; its message waits on its author, so it lands in their Needs you
and is pushed to their devices. Once delivered it stops and its line is checked off
(`[x] … ✅ <day>`); giving it a new time and `[ ]` arms it again. It has no cadence
or triggers, and resuming it keeps its time, which must still be ahead.

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
- **Create, edit, pause, resume, move, delete**: anyone who can edit the page,
  by editing its line. On a suggest-only page an Agent's edit is a
  suggestion, which changes nothing until a person accepts it.
- **Authority does not change hands in place.** An Automation runs with its
  author's Machines, Agents and name: whoever last changed what its line does
  (an Agent's author is its owner). Pausing, resuming and moving it keep its
  author; a change to what it does by anyone else atomically replaces it with
  a new Automation whose author is that writer. Every change is a page
  revision, so History shows who changed which line, in which conversation.
  The Automation's timer conversation remains private to the Hub; it is never
  shown or linked as the Automation's conversation.

Agents write and change lines with `xmatrix page edit`, and use `xmatrix page
automation list|run|pause|resume|delete <page-id>`; pause, resume and delete
change the line.

### 6.4 Storage and execution

- `data.automations` rows hold what runs and how it has run: `page_id`, and in
  `payload_json` the line each was synced from (`source`), the instruction,
  cadence, triggers and a reminder's time (`at`). The section is derived from
  the line, never stored as authority. The Channel-family authority of the
  Automation's timer conversation keeps executing it: alarm, occurrences,
  deadlines and cancellation are unchanged (docs/architecture/
  automation-execution-cancellation.md).
- After each committed revision that moves the head, the page session syncs
  the page's lines to its Automations (`page-schedule-sync.ts`), one sync at a
  time per page; restoring a revision and creating a page with schedule lines
  sync the same way. Dispatch rechecks the line in the head before each
  occurrence and fails it permanently when the line is gone, stopped or
  unreadable.
- Event triggers are matched by the Hub where the event arrives (the GitHub
  webhook, a connector's event ingress) against an index of enabled
  Automations by trigger key, and delivered to the Automation's authority as
  "due now".
- There is no Channel-scoped Automation and no reference link: contract
  migration 0235 rewrote each page Automation's `[name](xmatrix:automation/<id>)`
  reference into its line, after the line that held it, and wrote one with no
  reference paused at the end of its page.

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

### 6.6 Images and videos

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
  Pasting into an empty new Page first waits for that same write to create
  the Page, then binds the file to its permanent id.
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
- **An Agent can upload a local image or video.** `xmatrix page upload <page>
  <file>` uploads through the same private-content intent, verified bytes and
  Page-owned ref as the editor, then prints Markdown for `page edit` or live
  writing. It accepts the types above, from 1 byte through 64 MiB, and never
  changes the Page's text itself. Create a Page before uploading into it.
  The Hub checks the exact live Run, its owner's current Page edit access,
  the Space and canonical Page/content-hash ref before binding, including on
  replay. This check is separate from the content commit; a revocation after
  authorization may allow that in-flight binding to finish. A published Page
  exposes media only after its saved text references it.
- **Writing maps cached paths back and asks for an explicit upload of new files.** Every way an Agent writes
  into a page — `page edit`, `page create`, `⟦write⟧` in a reply or a message,
  live co-writing — passes its text through the CLI's `page_media` mapping:
  a path ending in `attachment-cache/page-media/<sha-256>.<ext>`, read on any
  machine, is the page's reference again; an image of any other local file
  (a path, `~`, a drive, a share, `file:`) is not written. `page edit` and
  `page create` refuse the whole text, except for images the page already had
  at the edit's base revision; a stream holds each image until it is whole
  and leaves a local one out, and the Agent is directed to `page upload`.
  Text never triggers implicit local-file reads or uploads. The editor does not take
  `file:` or `blob:` images from pasted HTML either.

## 7. Around the page

There is no side panel. What its tabs held is shown where it acts:

| Was | Now |
|---|---|
| Now: presence, running Agents | Cursors, the margin's Agents and each heading's avatars (§3.2) |
| Discussions | Cards beside their passages and the conversation list (§4.4) |
| Attached: Automations | Chips in the section they keep true (§6.1), written there by an Agent; the Space's Schedules list them all |
| Attached: connectors | A conversation linked to its section, a card like any other |
| History | A mode of the page: the margin lists revisions, and the document shows the chosen one's changes colored by author, with restore |
| Settings: publishing, suggestion mode | The Share dialog from the header |
| Settings: project governance | Open participation on the Space in Team; the governance page in Share ("Space rules": only owners and admins edit it, every Agent follows it), both for Space owners and admins |
| The move to pages | A notice on the page while an Agent's draft waits for an owner or admin |

A phone shows the same things on the page itself: the byline under the
title, headings and bubbles in the text, and Share and History in the
page's top bar.

Creating a page works as in Notion: the desktop list's + and Ctrl/⌘+N, the
phone's FAB, the empty list and a parent row's sub-page + each open a new page
at once, with no dialog or browser prompt, on its title, on a phone as on a
desktop. The title is the document's first line, drawn as its h1 with an
"Untitled" placeholder; there is no title field, so a new page looks exactly
like any page. A new page is an ordinary page on screen, with the same editor
and header, and there is no draft: it is made by its
first write, like copy-on-write. Until then its live document exists only in
the browser, and one opened and left empty is not kept anywhere. The first
write is a keystroke (letters typed on the first line make it the opening
heading) or calling an Agent. It makes the page under the chosen parent from that document
as it stands. The Hub keeps the document's markdown as revision 1 and starts
the page's live session from the same Yjs document, so the editor joins that
session without reloading and goes on syncing what is typed meanwhile. Enter after
the name goes on into the text; left without one the page stays unnamed. Until it is made, the header
is empty. A failed make says so on the page, and the next write
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
4. The Attached tab, with Automations and GitHub subscriptions in
   conversations linked to a section (v0.16.470).
5. Side-panel tabs and history diffs (v0.16.470); save state, named fading
   cursors, title rename, table controls and links from URLs (v0.16.471).
6. Conversations beside the page (§4.4): the page's links carry each
   conversation's summary for the reader and each section's working Agents;
   margin cards, the conversation docked beside the page, presence on
   headings, the header's avatars, Share, History as a mode and the ⋯
   menu, with no side panel (§7).
7. Live co-writing (§4.2) with any Agent: the session's engine (#529), the
   runtime's bridge with start and stop and the caret's status and note
   (#531, v1.0.427), then its words fading in and Undo; an Agent's edit while
   it co-writes goes straight in, and suggestions are a suggest-only page's.

Open:

- Automation timing moved off each Automation's timer conversation onto its
  page (§6.4).
- Change events pushed to a Run when a block it read or edited changes
  (§3.1), and "changes since your last visit" for people.
- Live references for GitHub issues and pull requests (§2.4).
- Images.
