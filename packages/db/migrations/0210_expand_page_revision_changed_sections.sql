-- The sections each page revision changed against the revision before it,
-- derived from the two bodies when a page's awareness is first read and kept
-- so later reads compare no documents (packages/db/src/page-section-changes.ts).
-- NULL until derived; a purge, which rewrites bodies, sets it back to NULL for
-- the whole page. A cache of a derivation: the bodies remain the source.

-- Fail fast instead of queueing Runtime traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.page_revisions ADD COLUMN changed_blocks TEXT[];
