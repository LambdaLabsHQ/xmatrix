-- A page's summary: one line saying how the page stands, written for one
-- revision of it by the Run that read that revision. The page list shows it
-- under the page's title. NULL until a summary is written.

-- Fail fast instead of queueing page writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.pages
  ADD COLUMN summary TEXT CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 240),
  ADD COLUMN summary_revision BIGINT CHECK (summary_revision IS NULL OR summary_revision >= 1),
  ADD COLUMN summary_at TIMESTAMPTZ,
  ADD CONSTRAINT pages_summary_whole CHECK ((summary IS NULL) = (summary_revision IS NULL)
    AND (summary IS NULL) = (summary_at IS NULL));
