-- What of a page each person has seen (docs/design/pages-live-document.md §3.1),
-- when they have seen part of it past `revision`: the page with each block
-- that was on their screen as it was then, and each other block as they saw it
-- at `revision` or since. NULL means exactly `revision`'s text.

-- Fail fast instead of queueing Runtime traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.page_reads
  ADD COLUMN seen_body TEXT CHECK (octet_length(seen_body) <= 262144);
