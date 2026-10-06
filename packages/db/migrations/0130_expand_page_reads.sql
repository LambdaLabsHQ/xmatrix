-- How far each person has read each page (docs/design/pages-live-document.md §3.1):
-- the newest revision they have had on screen. Opening the page again shows what
-- changed after it, and History marks a page that moved past it. One row per
-- person and page; it only moves forward.

-- Fail fast instead of queueing Runtime traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE data.page_reads (
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  page_id TEXT NOT NULL CHECK (length(page_id) BETWEEN 1 AND 300),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 300),
  revision BIGINT NOT NULL CHECK (revision >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, page_id, user_id)
);
