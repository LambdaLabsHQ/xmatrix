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

## Input evidence and About authority

About sessions have only their own Channel's history, metadata history and
metadata write HTTP capabilities. Their catalog response queries only that
Channel, with no Space catalog manifests or attention context. The task injects
its Channel id, current title, About and revision, trigger request and message
id. The generator is instructed to use only the scoped authoritative history;
conversation data is not executable instruction authority. Automatic titles may
continue to change while `autoName` is true.

Each authorized About history page records its metadata snapshot, content
revision and the exact message window in `data.channel_about_inputs`. References
carry message id, Channel id, sequence, entity version, content hash, immutable
payload kind/ref and record/body digests. Inline encoded payload bundles are
preserved because an object reference alone cannot recover that input. Input inspection omits payloads and refs after their message is recalled,
deleted, or edited to different content; stored audit digests remain. Ordinary
retention and Space purge still apply. History references are audit evidence,
not an additional content-read capability.

`xmatrix channel history <channel> --authoritative` bypasses the daemon's shared
history cache and prints the input id and `expectedRevision`. An oversized About
page is refused rather than silently trimming the recorded window; request a
smaller history limit through the API in that case. A Run may record up to 1000
pages for one generated revision. Inputs from different metadata revisions
require a fresh session.

The write transaction rechecks that the Run is live, belongs to the exact
Channel, is a registration-backed About session, and its owner is still a Space
admin. It rejects other metadata operations, foreign or unrecorded through
messages, missing inputs and stale revisions. The revision stores the trigger
and input ids from server-owned records. Coalesced successor tasks carry their
pending trigger message rather than substituting the original one.

## Direct About submission

The generated summary and optional automatic title are sent directly through
`xmatrix channel about <id> --summary "<text>" [--name "<title>"]
--through <message-id> --expected-revision N`.
The new CLI also accepts the same text as JSON with `--stdin`.
Stdin is a UTF-8 JSON object containing `summary` and optional `name` only;
On Windows, ASCII-only PowerShell source can decode JSON Unicode escapes
with `ConvertFrom-Json` and pass Unicode native arguments; ASCII-only JSON
escapes also work with stdin. No local files are written or read:
`--summary-file` and `--name-file` have been removed, along with the file-age
check. Input is bounded to 64 KiB and malformed or unsupported fields are
refused before the Hub update.

The CLI forwards the text to the existing scoped Channel PATCH. The Hub's
transaction updates the database row and appends its immutable revision and
recorded input evidence. This changes input transport, not database or Run
authority. Hub prompts and CLI ship together. Prompts default to existing
inline arguments so daemons awaiting CLI updates still work, and offer JSON
stdin only when the CLI advertises support. An older prompt using file flags is rejected by
the new CLI rather than reading a residual file.

## Reading and restoring

- `GET /api/channels/:id/metadata-history` returns newest first, with
  `currentRevision` and `hasMore`. `limit` is 1–100 (default 20),
  `beforeRevision` pages backwards, and `revision` selects a single version.
- The same endpoint with `inputId` returns one recorded input window, bounded
  to 200 references. Both queries use the Channel's current content-read policy.
- `POST /api/channels/:id/metadata-restore` takes `{ revision, expectedRevision }`.
  The existing configuration permission and exact Run delegation apply; an About
  Run cannot restore. Restoring copies the content and original summary source
  into a new revision attributed to the restorer. The bad version stays visible.
- CLI: `xmatrix channel metadata-history <id> [--revision N|--before-revision N]`
  and `--input <input-id>` inspect evidence;
  `xmatrix channel metadata-restore <id> --revision N --expected-revision M`
  restores it. `channel about` accepts `--expected-revision M`.

The ordinary PATCH accepts `expectedRevision`; stale values return HTTP 409
`metadata_revision_conflict`. About clients that omit it are pinned to their
server-recorded input revision, preserving CAS without trusting a latest-read
fallback. Existing manual title clients may omit it during coordinated client
rollout; they still append history. Restoration always requires the revision.
Hub and CLI ship together through the release train. Old About clients that
only consumed a daemon cache fail closed if no authoritative input was recorded.

Content fields are protected against SQL UPDATE by triggers. Only storage
`space_id` may change during an authorized Channel transfer; original Space and
content stay unchanged. History follows the Channel's current permissions and
shard movement, and normal Channel/Space deletion removes it under retention.
There is no product operation for editing or deleting individual history rows.

## Verification

PostgreSQL regressions exercise full snapshots, append restoration, replay,
concurrent CAS, failure rollback, immutable-content triggers, Channel permission
revocation and About Run/input scope. Hub end-to-end coverage crosses real
registration launch, recorded history, stale and foreign input refusal, a
successful About update, history inspection, restoration and a coalesced
successor. CLI argument and Channel tests cover the command surface.
