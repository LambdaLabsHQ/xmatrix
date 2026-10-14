-- Co-writing (docs/design/pages-live-document.md §4.2): a person starts an
-- Agent writing a page from the page itself, in a conversation of its own.
-- While that conversation co-writes the page, the Agent's edits to it are kept
-- as suggestions the person takes or leaves one by one, not written into the
-- page. Agents working from any other conversation edit as before.

-- Fail fast instead of queueing page writes behind this transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE data.page_co_writing (
  space_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  started_by_user_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  -- Set when the person ends it; a co-writing also lapses on its own.
  ended_at TIMESTAMPTZ,
  PRIMARY KEY (space_id, page_id, conversation_id),
  CHECK (length(conversation_id) BETWEEN 1 AND 300),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- Suggestions up to this revision have been taken or left by a person; later
-- ones still wait on the page. NULL until the first is reviewed.
ALTER TABLE data.pages
  ADD COLUMN suggestions_reviewed_through BIGINT
    CHECK (suggestions_reviewed_through IS NULL OR suggestions_reviewed_through >= 1);
