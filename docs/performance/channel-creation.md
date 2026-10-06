# Channel creation latency

The product target is immediate feedback when starting frequent, informal
conversations. Opening the new-conversation composer is local. Sending its first
message currently waits for channel creation and then message append before
navigating to the conversation. Database creation latency is only one part of
that end-to-end path.

## PostgreSQL creation path

Channel creation reads membership, Space policy, and channel-ID conflicts in one
statement within the existing serializable transaction. It allocates the search
rank inside the channel INSERT and returns the stored rank. This removes three
serial SQL round trips from a successful creation compared with separate reads
and rank allocation; it does not change the API or require a migration.

Authorization error precedence, feedback-Space policy, participant intake,
closed-channel grants, insert conflict handling, the outbox, and idempotent
receipts remain in the transaction. The global directory is still published
before returning. Catalog notifications and the Hub's presence read still run
on the response path.

## Validation and remaining measurements

- `pnpm --filter @xmatrix/protocol build`
- `pnpm --filter @xmatrix/db test`
- With an isolated, migrated PostgreSQL test database configured through
  `XMATRIX_TEST_POSTGRES_URL`, run
  `node --test packages/db/test/channel-catalog-postgres.test.mjs`. This covers
  concurrent same-name creation, distinct ranks, replay, ID conflicts, immediate
  reads, and the existing direct-conversation race.

Unit coverage checks policy rejection before writes, participant metadata,
conflict recovery, replay, and PostgreSQL syntax. Mock execution times are not
database or product latency measurements. Real PostgreSQL integration requires
the test database; the suite skips those tests when it is absent.

Before claiming imperceptible latency, measure click-to-feedback and
send-to-visible-message p50/p95/p99, including cold requests, closed channels,
attachments, and concurrent creation. Profile directory publication, catalog
fanout, presence hydration, and first-message append separately. An immediate
pending-message UI also needs explicit failure/retry behavior; this database
change alone does not provide that interaction.
