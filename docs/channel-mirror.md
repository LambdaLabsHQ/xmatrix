# Channel mirrors (retired)

Pages hold what a Space knows (see [Pages and Conversations](design/pages-and-conversations.md)).
Channel memory is retired: moving a Space to pages carried it onto pages, and its
entries stay in `data.message_annotations` as data that nothing reads. There is no
`xmatrix memory` command.

## A Run's pages

A new Run's launch context carries the conversation's linked pages whole, at the
revision read then (`packages/hub/src/agent-launch-context.ts`), ahead of its channel
history; a page that does not fit the budget is named with its `page read` instead of
being cut. A schedule occurrence's conversation is linked to its section, so its Agent
starts from the page. Later in a Run, read linked pages directly from the Hub:

```sh
xmatrix page linked                       # this Run's conversation
xmatrix page linked --conversation <id>    # another authorized conversation
xmatrix page read <page-id>                # current revision, claims and awareness
```

`page linked` returns the conversation's readable linked pages in link order,
including their bodies and revision headers, through `GET /api/channels/:id/pages`.
Outside a Run, supply `--conversation`. No page files are copied to disk at
launch or while a Run is idle. Read again when current state matters, and edit
with `xmatrix page edit` against the revision you read.

This replaces the daemon's 15-second page-mirror poll: idle conversations no longer
cause Worker requests, CPU work, database reads or local file rewrites. Existing
`~/.claude/memory/channels/` files are left untouched but are stale historical
snapshots, not current page state. Older daemons keep working with the existing
Machine Daemon endpoint until they update; deploying Hub alone does not stop them.

## The Channel About reads nothing on a Machine

A conversation's About is one text task (`docs/design/channel-metadata-revisions.md`):
the Hub hands the harness that conversation's text, and the Machine keeps no
mirror or overlay of any Channel for it.
