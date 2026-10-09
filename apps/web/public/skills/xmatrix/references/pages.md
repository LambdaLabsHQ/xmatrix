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

When your work changed nothing on the pages, say so before you finish:

```sh
xmatrix page done -m "the fix did not change how things stand"
```

Link a page, or one of its sections, to a conversation, and claim a section
while you work on it so others see it is taken (claims lapse on their own):

```sh
xmatrix page link <page-id> [--block <section-slug>] [--conversation <id>]
xmatrix page claim <page-id> --block <section-slug> [--minutes 120]
xmatrix page release <page-id> --block <section-slug>
xmatrix page claims <page-id>
```

A pull request that names a claimed section by its link passes the
`xmatrix/claim` check for its author.
