-- A person or Agent unlinked a page from a conversation. Reading, editing or
-- mentioning the page from that conversation does not link it again; only an
-- explicit link does, and it removes this row. Old Hubs never read it, so
-- until they drain they may still link the page back implicitly.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.page_unlinks (
  space_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  unlinked_by_kind TEXT NOT NULL CHECK (unlinked_by_kind IN ('user', 'agent')),
  unlinked_by_id TEXT NOT NULL,
  unlinked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, conversation_id, page_id),
  CHECK (length(conversation_id) BETWEEN 1 AND 300)
);
CREATE INDEX page_unlinks_page_idx ON data.page_unlinks (space_id, page_id);
