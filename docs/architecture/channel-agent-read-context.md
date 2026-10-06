# Channel context for Agent reads

`xmatrix channel history` and a newly launched Agent's read-only history bootstrap
include the stored Channel Summary and opened-thread references before the
transcript. Each reference carries `rootMessageId`, the thread's `channelId`,
and its current name. History entries include message IDs so the reference
identifies an exact parent message even when two messages have identical text. The Summary is labeled as derived context
that may lag recent messages; a missing Summary is reported as unavailable.

Thread references are derived from the current authorized, active Channel catalog.
A child must have `metadata.kind = "thread"`, a nonempty `threadRootMessageId`,
and a `threadRootChannelId` matching its parent Channel. Ordinary children and
mismatched roots are omitted. Neither message text nor a caller-supplied message
metadata object establishes this relationship. The catalog remains authoritative;
these references do not join a Channel or grant additional access.

An archived thread stays listed with its `archivedAt` and, when one was written,
its `archiveReason`: the closing line stored with the archive (what was asked,
what was done, how it ended). The header states that every listed root has been
picked up, that an archived thread is closed work rather than undone work, and
that the thread list and the transcript win over the Summary where they
disagree. A read of an archived Channel itself opens with its `State: archived
at` line followed by an `Archive reason` line when one exists.

`archiveReason` is written by `channel_archive_tree` (the `reason` the
`channel_archive` management operation already accepted now lands on every
Channel in the archived tree instead of only in the audit record), may be set
or cleared on an archived Channel through `channel_update`, and is dropped by
restore. Like `archivedAt`, it is stored in Channel metadata and exposed as a
top-level field, so readers check both locations. The CLI history read and
the launch bootstrap also stamp each thread-root transcript line with
`[thread=<channelId>: ...]` (or `[thread=<channelId> archived=<at>: ...]`), so
a reader working down the transcript sees the thread state on the message
itself instead of having to cross-reference an opaque `rootMessageId` list.
The Channel About prompt says the same thing to the summarizing Agent: an
archived thread was closed out, not left unclaimed.

CLI reads fetch catalog context separately from cached message history. A failed
context read is reported without suppressing readable history. Bootstrap uses the
same reader and retains the existing resume and history-replay exclusions.

When Hub returns HTTP 503 with `channel_catalog_timeout`, the CLI includes the
recognized failed boundary (`directory`, `authority_page`, `revision_probe`,
`projection`, or `runtime_presence`) after the existing error text. This is a
bounded diagnostic, not authorization or permission to retry a mutation. Unknown
boundary values and unrelated refusal bodies keep the existing error output.
Older clients still display the original error text; Hub query deadlines and
permission checks are unchanged.
