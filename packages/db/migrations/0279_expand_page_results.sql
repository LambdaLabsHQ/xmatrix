-- The Overview (docs/design/pages-overview.md): what a person missed and what waits on them.
--
-- page_results: what a change to a page resulted in, in one sentence with its kind, written by the
--   page's summary execution for the revision it read. Only changes a reader needs have a row.
-- page_result_marks: the results a person has handled (a problem they checked off or answered);
--   conversation_id is where they answered it, when they did.
-- page_overview_reads: how far a person has seen the Space's results. It only moves forward.

-- Fail fast instead of queueing Runtime traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE data.page_results (
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  page_id TEXT NOT NULL CHECK (length(page_id) BETWEEN 1 AND 300),
  revision BIGINT NOT NULL CHECK (revision >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('shipped', 'decided', 'problem', 'fixed', 'number')),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 240),
  block_id TEXT CHECK (block_id IS NULL OR length(block_id) BETWEEN 1 AND 300),
  block_title TEXT CHECK (block_title IS NULL OR char_length(block_title) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, page_id, revision),
  CHECK ((block_id IS NULL) = (block_title IS NULL))
);

CREATE INDEX page_results_space_created_idx ON data.page_results (space_id, created_at DESC);

CREATE TABLE data.page_result_marks (
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 300),
  page_id TEXT NOT NULL CHECK (length(page_id) BETWEEN 1 AND 300),
  revision BIGINT NOT NULL CHECK (revision >= 1),
  conversation_id TEXT CHECK (conversation_id IS NULL OR length(conversation_id) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, user_id, page_id, revision)
);

CREATE TABLE data.page_overview_reads (
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 300),
  seen_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
