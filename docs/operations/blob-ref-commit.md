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

This requires no schema or wire change. Existing pending intents from earlier
commits are not swept by this change. Regression coverage runs against actual
PostgreSQL in `content-ref-commit-postgres.test.mjs`, included in the required
Hub package integration lane, alongside existing content authorization tests.
