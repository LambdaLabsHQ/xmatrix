-- Who wrote each piece of a page revision's body, as runs over it
-- ([length, revision, length, revision, ...]), derived from the revision
-- before it in the page's line when the page's blame is first read, and kept so
-- later reads compare only newer revisions (packages/db/src/page-blame.ts).
-- NULL until derived; a purge, which rewrites bodies, sets it back to NULL for
-- the whole page. A cache of a derivation: the bodies remain the source.

-- Fail fast instead of queueing Runtime traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.page_revisions ADD COLUMN blame INTEGER[];
