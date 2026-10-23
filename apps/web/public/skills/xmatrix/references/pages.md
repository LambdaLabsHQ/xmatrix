# Pages

Pages are the Space's living documents: they say how things stand, who is on
what, and what is done. Conversations are where work happens; pages are what a
Space knows. The page tree is the work index. Read the pages a conversation
works on before you start, and keep them true when your work changes how
things stand.

A section that still describes unfinished work, and names a conversation, is
the reason to open that one conversation. Once the section states the current
outcome, do not open the conversation to recover it.

## Writing a page

A page is read far more often than it is written, so keep it what a newcomer
needs to act now:

- **Current truth only.** State, decisions in force (with the reason in one
  line), and open work. Done work shrinks to a line or goes; a superseded
  decision is deleted, not kept as history.
- **No evidence on the page.** Commit SHAs, CI and release run ids,
  timestamps of steps, test counts and who did what when belong in the pull
  request and the conversation. A PR number is enough.
- **One fact, one place.** Link to the page, section or repository file that
  owns a fact instead of copying it.
- **Small.** A section is a few lines; status is a table with one short
  sentence per cell. When a page grows past a screen or two, cut what is no
  longer true or split it into child pages.
- **Rewrite, never append.** When a section has become a log, rewrite it in
  place to the current state and leave how it changed in the conversation.

Read the pages linked to your conversation on demand from the Hub. Ordinary Runs
have no automatically refreshed page files:

```sh
xmatrix page linked                   # linked pages, bodies and revisions
xmatrix page linked --conversation <id> # explicit authorized conversation
xmatrix page tree                     # the pages you can read
xmatrix page read <page-id>            # current revision and who is working on it
xmatrix page history <page-id>
```

Edit against the revision you read; a stale revision is refused, so read again
and reapply:

```sh
xmatrix page edit <page-id> --base <revision> -f ./page.md [--block <section-slug>]
```

### Writing into a page as you reply

In a Run, words you put between these markers in your reply go into the page
as you write them, under your caret, while people on the page watch:

```text
⟦write page:<page-id>⟧
⟦after "words on the page"⟧
Markdown to add right after the paragraph, heading, list or table holding
those words.
⟦/write⟧
```

One `⟦write⟧` may write in several places, each starting with a marker:

- `⟦after "words on the page"⟧`, then markdown to add after the block holding
  those words.
- `⟦replace "words on the page"⟧`, then the new wording of exactly those words,
  within one paragraph.
- `⟦note "words on the page"⟧`, then a short remark to the people about them.

Quote a few words that appear once on the page, exactly as `xmatrix page read`
shows them. If someone edits what you are writing, you stop there, and when
part of it did not reach the page you hear why. While people have the page
open, your words reach it at their reading pace, so a long write keeps
appearing for a while after you wrote it; carry on, and do not write it again.
Write it in your reply, where it
goes in as you write it; a `⟦write⟧` in a message you send with `xmatrix send`
is written into the page at once, and the message keeps a note instead. Use `xmatrix page edit` to
restructure a page (move, delete or rewrite sections), and on pages that take
Agent edits as suggestions.

When your work changed nothing on the pages, say so before you finish:

```sh
xmatrix page done -m "the fix did not change how things stand"
```

Link a page, or one of its sections, to a conversation, and claim a section
while you work on it so other Agents see who is on what (claims lapse on their
own). A claim locks nothing: if others are already on the section you are told
who and where, and they are told about you. Talk to them there, pick other
work, or carry on side by side.

```sh
xmatrix page link <page-id> [--block <section-slug>] [--conversation <id>]
xmatrix page claim <page-id> --block <section-slug> [--minutes 120]
xmatrix page release <page-id> --block <section-slug>
xmatrix page claims <page-id>
```

A pull request names the section it works on by its link. Naming it gates
nothing; a member's pull request is pre-reviewed there, and once merged the
section owes an update.
