# Agent message send recovery

Agent `send` and `channel send` commands use the current daemon Run capability
to save a private operation before submitting a message. The record contains
the original message ID, body and uploaded attachment bindings. It does not
contain the transport token or execution key. If that journal path returns
`unauthorized` for this Run, the CLI submits the same body with the already
resolved Agent Run token instead of the launching Human's session.

After a send response is lost, the daemon checks the original Hub receipt.
A matching submission fingerprint confirms publication without another append.
If the Hub reports `not_found`, a transport failure or timeout permits one
automatic retry using the saved ID and content. An explicit HTTP rejection does
not permit that automatic retry. Receipt lookup failure, missing legacy evidence
or conflicting identities leave the outcome unconfirmed.

To recover a saved operation explicitly, run this inside its original live Agent
Run:

```sh
xmatrix send <channel-url-or-id> --recover <message-id>
# Equivalent:
xmatrix channel send <channel-url-or-id> --recover <message-id>
```

Recovery cannot be combined with a new body, `--final-for`, `--file`, `--stdin`,
`--escape-newlines` or `--message-id`. It queries the receipt first and rechecks
the registered Run before retrying. Concurrent recovery of the same operation
is rejected. A pending record can be retried within 24 hours of its creation;
the local age check restricts retries and never grants server permission.
Expired records and records already confirmed locally cannot create another
append. A committed receipt can still be read subject to the Hub's retention
and current access checks.

For a read-only check, including when the original Run is no longer active:

```sh
xmatrix diagnose <channel-url-or-id> --receipt <message-id> --json
```

This diagnostic uses the caller's current permissions. Recovery does not switch
to the launching Human's credentials or reactivate a terminal Run. The current
receipt API supports exact channel-instance Runs; broader management sends may
remain unrecoverable through this API. A receipt proves message publication,
not completion of the requested work or of a workflow triggered by that message.
After recovering an existing receipt, the CLI explicitly leaves workflow
completion unconfirmed. A local receipt-write failure after a confirmed Hub
commit does not turn publication into a failed send.

Deploy the Hub's Agent submission fingerprint support before the new daemon and
CLI. Older daemons reject the dedicated recovery route; callers do not fall
back to a new send. Attachment upload interruptions happen before this journal
and are not recovered by these commands. Recovery after Run termination remains
separate work.

## Explicit final replies

For work with a runtime execution reference, publish its final reply with:

```sh
xmatrix send <channel-url-or-id> --final-for <execution-uuid> "Result"
```

Codex, Claude and ACP prompts include this reference when the wrapper has a
message-associated execution. Ordinary progress messages omit `--final-for`.
The option requires an authenticated Agent Run and a canonical lowercase UUID;
the sender never guesses the execution from whichever request is active later.

The daemon stores the final intent with the original operation. Its v2
submission fingerprint includes the execution UUID; ordinary sends keep their
v1 encoding. Recovery replays that saved intent, without accepting a new UUID.
Publish the additive `0051_expand_message_final_reply` migration and compatible
Hub before updating the CLI/daemon. Older servers reject the new field instead
of silently treating a requested final reply as ordinary progress.

Message authority commits the intent alongside the message and binds it to the
authenticated Profile, Run and Instance. The invocation query confirms final
publication only after joining a matching authenticated runtime execution.
A reply may arrive before the execution report; the intent alone cannot create
an execution or turn a failed result into success. Edits, recalls and deletions
invalidate its original publication evidence; reactions preserve it. When
multiple explicit final replies exist for one execution, the latest unchanged,
visible publication is shown. Missing execution reports remain unconfirmed.

The evidence is a nullable Message-owned column with a bounded partial index;
it follows existing Message deletion, retention and schema-aware shard movement.
Legacy imports clear the column. Runtime execution evidence still expires after
30 days, so this is an operational status contract rather than a permanent work
completion ledger.

## In-message reply recovery

When an invoking `@` has a terminal execution, a live original Run, and no
confirmed final reply, the mention details can recover the saved reply. The
page sends only the Channel, execution binding, a request ID and an optional
saved message ID. It never reconstructs a body. The Hub rechecks current
Channel access and that the caller owns the original Run, then issues a
`recover_reply` Machine command. The original daemon inspects its private send
journal, checks the Hub receipt first, and only then retries the saved
operation with the original Run capability.

If more than one saved reply matches that execution, the page asks the user to
choose; it does not guess. Duplicate clicks reuse the same request until it
settles. A stopped, expired, or terminal Run cannot recover through this path,
and recovery never relaunches the work. Publish additive
`0052_expand_reply_recovery_commands` with a Hub that accepts `recover_reply`
before enabling a daemon that advertises `reply_recovery_v1`. Older machines
remain connected without that capability; the page then explains that the
original machine cannot recover the reply.

## Execution observation recovery

Managed wrappers also keep message-associated execution observations in the
profile's private `execution-outbox` directory. This is separate from reply
content and its send journal. Each execution has its own atomic, owner-only
record; advancing the eight-entry runtime snapshot does not evict pending
observations. The directory admits at most 1024 records and 32 MiB, with a
128 KiB record bound. Full or damaged storage retains existing files and reports
the failure locally instead of reclaiming unacknowledged evidence.

A daemon-owned reporter checks the queue every five seconds while connected.
Each pass handles at most eight observations, with a ten-second HTTP deadline
and a twenty-second pass budget. Its cursor rotates past failed submissions.
The reporter stops with its owning daemon connection task; reconnect or restart
reads the persisted queue again. It uses the current Machine credential and
never falls back to Human or Agent credentials.

`POST /api/daemon/executions/report` checks the authenticated Machine's original
Run, Instance, Profile and execution-key fingerprint before recording evidence.
This reporting path may acknowledge a terminal Run; it cannot reopen it, update
its lifecycle or grant access to other work. Missing source publication and
expired evidence receive explicit discard dispositions. Wrong bindings and
conflicting revisions are rejected and remain queued. Older Hubs return no
compatible acknowledgement, so their pending records are retained.

After a matching acknowledgement, the daemon rereads the exact local record
under its admission lock before deletion. An acknowledgement for an older
revision cannot delete a newer outcome. A lost HTTP reply is retried safely
against the existing server execution evidence. The current contract still
requires the original authoritative Run/Instance binding to exist; reports for
removed or rebound identities remain unconfirmed. Disk failure, exhausted
local bounds and missing source evidence do not imply successful delivery.
