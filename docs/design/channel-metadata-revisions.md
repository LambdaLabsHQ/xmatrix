# Channel title and About revisions

The Channel row remains the authority for its current title and About. Each
content change appends a complete immutable record to
`data.channel_metadata_revisions` in the same transaction as the current row,
its catalog projection, command replay and outbox. `metadata.metadataRevision`
starts at zero and advances independently of the Channel's configuration
version. The record includes its Channel, original Space, parent revision,
title, About, automatic naming state, summary source, actor, Run when present,
command identity and time. Unrelated mode and topic updates do not advance it.

Existing Channels preserve their current content as revision zero at the first
content update. That baseline explicitly has unknown provenance. This does not
reconstruct overwritten history or determine the reported cross-Channel incident
(2026-10-07, remote About execution #6 still missing).

## How an About is written

A conversation's About is written by one text task (`machine_text_task`,
`packages/hub/src/channel-about.ts`), the way a page's summary is. A task starts
after the fifth message and every fifth after it, after the first message while
nobody has named the conversation, and when someone who reads the conversation
asks for it again (`POST /api/spaces/:spaceId/channel-about`).

- The Hub picks the first of the Space's enabled Agents whose Machine is online
  and takes text tasks, and whose owner may read the conversation. It reads the
  conversation as that owner before any of it reaches the Machine.
- The harness is handed the conversation's name, current summary and newest
  messages (at most 64 KiB, each message cut at 2,000 characters) and an
  instruction in the Space's language setting. Nothing else reaches it: no token,
  no tools, no workspace, no other conversation. It starts fresh in an empty
  private directory and keeps nothing: Claude runs with
  `--no-session-persistence --safe-mode --strict-mcp-config` and Codex with
  `--ephemeral --ignore-user-config`, each flag where the installed version
  lists it.
- It answers one JSON object: the summary (at most 240 characters) and, while
  nobody has named the conversation, a name (at most 40).
- The Hub writes the answer as a revision with source `about_task`: the task id,
  the harness, the revision it read and the newest message it was given. The
  actor is the Machine's owner, who needs only Space membership, since the write
  is xMatrix's. A revision made after the reading wins if it is a person's change
  or an About that read as far or further. The answer is then dropped, and the
  next reading writes the About.
- The task id `channel-about:<channel>:<revision read>:<newest sequence>:<name|summary>:<uuid>`
  names the reading, so the answer needs no other record. The machine command is
  the task's only record.

Until 2026-10-15, an About Agent Run wrote the About. It read history through
`xmatrix channel history --authoritative` and submitted through
`xmatrix channel about`. Those Runs carried context between conversations inside
their harnesses, which caused the cross-Channel replays of 2026-10-07 to
2026-10-15. Their recorded inputs (`data.channel_about_inputs`) and their
revisions with source `about` stay readable. The Run machinery is being removed.

## Reading and restoring

- `GET /api/channels/:id/metadata-history` returns newest first, with
  `currentRevision` and `hasMore`. `limit` is 1–100 (default 20),
  `beforeRevision` pages backwards, and `revision` selects a single version.
- The same endpoint with `inputId` returns one input window an About Run
  recorded, bounded to 200 references. Both queries use the Channel's current
  content-read policy.
- `POST /api/channels/:id/metadata-restore` takes `{ revision, expectedRevision }`.
  The existing configuration permission and exact Run delegation apply.
  Restoring copies the content and original summary source into a new revision
  attributed to the restorer. The bad version stays visible.
- CLI: `xmatrix channel metadata-history <id> [--revision N|--before-revision N]`
  and `--input <input-id>` inspect evidence;
  `xmatrix channel metadata-restore <id> --revision N --expected-revision M`
  restores it.

The ordinary PATCH accepts `expectedRevision`; stale values return HTTP 409
`metadata_revision_conflict`. Manual title clients may omit it; they still append
history. Restoration always requires the revision.

Content fields are protected against SQL UPDATE by triggers. Only storage
`space_id` may change during an authorized Channel transfer; original Space and
content stay unchanged. History follows the Channel's current permissions and
shard movement, and normal Channel/Space deletion removes it under retention.
There is no product operation for editing or deleting individual history rows.

## Verification

PostgreSQL regressions exercise full snapshots, append restoration, replay,
concurrent CAS, failure rollback, immutable-content triggers, Channel permission
revocation, and task-written Abouts: a member's Machine, a further reading over
an older one, never the reverse, and a person's change standing. Hub end-to-end
coverage sends the About task to a real daemon connection and checks that
another conversation's text never reaches it. It writes the answer, drops one
read before a rename, and runs an asked-for reading again.
