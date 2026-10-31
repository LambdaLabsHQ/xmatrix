# Blob reference commits

`PostgresContentRepository.commitRef` resolves a verified upload to one immutable
object and one generation-zero hold per owner and object. The database's unique
constraints elect both identities. Object creation tolerates a concurrent
winner, then reads and locks that object in a fresh statement and checks its
kind, storage key, checksum, size and child count. A conflict never overwrites
immutable metadata or widens a reference's visibility scope.

Inserting a hold and adopting an existing hold share the same completion:
consume the validated upload intent, cancel the object's pending GC candidate,
and record the canonical reference in the transaction's outbox and replay
result. The existing-ref replay path does not consume an unvalidated intent.
Reference timestamps belong to the hold, independently of when its object was
first uploaded.

After commit, publish the consumed intent's terminal route and the returned
reference's active route. A retry repairs the canonical reference's route even
when a previous transaction committed but its directory publication failed.
The unused caller-proposed reference ID receives no route. Web and CLI callers
adopt the returned ID and keep one attachment slot for duplicate bytes.

## Upload sizes

A private blob (Channel attachment, Page media) has one size ceiling,
`RELAY_V2_BLOB_MAX_BYTES`: 10,000 R2 multipart parts of 64 MiB, 625 GiB. R2
stores objects up to 5 TiB, but every byte reaches it through a Worker request
(100 MB on every plan), and 10,000 parts that each fit one carry no more.

A body up to 64 MiB goes in one PUT, which R2 verifies against its SHA-256. A
larger one goes as a multipart upload straight to its content-addressed key:
the intent records the R2 upload id, the part size, each part's ETag and the
SHA-256 state after the recorded parts (migration
`0234_expand_blob_multipart_upload`). Parts go in order; the Hub carries the
digest from part to part (`packages/protocol/src/resumable-sha256.ts`, since a
platform digest cannot be resumed across requests) and, on the last part,
compares it with the intent. A mismatch aborts the R2 upload and resets the
intent; a match lets `…/multipart/complete` publish the parts, so the key never
shows unverified bytes. Each part keeps the intent live for another hour. An
upload abandoned without a mismatch is left to R2's lifecycle rule, which
aborts incomplete multipart uploads after seven days.

Reads (`product-media`, Page media) answer a `Range` request in part and stream
through the Web; the browser keeps only attachments up to 64 MiB in Cache
Storage.

## Storage metering

A Space holds a content object while any of its refs names it; objects are
immutable and shared, so a second ref to held bytes changes nothing. Content
objects are never deleted outside Space and Channel purges, so storage is
metered on refs: the first ref to an object adds its bytes to
`data.space_storage_usage` (category `attachments`) in the commit transaction,
and releasing or expiring its last ref subtracts them in that transaction. A
Space's first metered change counts everything it already holds, so its row
never starts from a guess. A Channel purge drops refs in bulk and counts the
Space again when it completes. Every change is handed to the billing policy's
`storageChanged`, and every upload is admitted by its `storageUpload`, before
any byte is sent.

The ref commit itself required no schema or wire change. Existing pending intents from earlier
commits are not swept by this change. Regression coverage runs against actual
PostgreSQL in `content-ref-commit-postgres.test.mjs`, included in the required
Hub package integration lane, alongside existing content authorization tests.
