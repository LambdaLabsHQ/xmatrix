# Channel mirrors (retired)

Pages hold what a Space knows (see [Pages and Conversations](design/pages-and-conversations.md)).
Channel memory is retired: moving a Space to pages carried it onto pages, and its
entries stay in `data.message_annotations` as data that nothing reads. There is no
`xmatrix memory` command.

## A Run's pages

Ordinary Runs read linked pages directly from the Hub when they need them:

```sh
xmatrix page linked                       # this Run's conversation
xmatrix page linked --conversation <id>    # another authorized conversation
xmatrix page read <page-id>                # current revision, claims and awareness
```

`page linked` returns the conversation's readable linked pages in link order,
including their bodies and revision headers, through `GET /api/channels/:id/pages`.
Outside a Run, supply `--conversation`. No page files are copied automatically at
launch or while a Run is idle. Read again when current state matters, and edit
with `xmatrix page edit` against the revision you read.

This replaces the daemon's 15-second page-mirror poll: idle conversations no longer
cause Worker requests, CPU work, database reads or local file rewrites. Existing
`~/.claude/memory/channels/` files are left untouched but are stale historical
snapshots, not current page state. Older daemons keep working with the existing
Machine Daemon endpoint until they update; deploying Hub alone does not stop them.

## Channel About sessions read on demand

A Channel About session is an ordinary Run in a synthetic workspace. Like any
Run, it reads what it needs when it needs it: `xmatrix channel history`. No
Space mirror is materialized at launch or kept in sync, and the Hub serves no
whole-Space overlay. Released daemons honour this because every About launch
says `managementProjectionKind: "channel"` (read on demand).
