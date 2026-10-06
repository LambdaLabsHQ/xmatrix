-- A discussion is a conversation anchored to a range of a page's text
-- (docs/design/pages-live-document.md §4.3). The anchor is two Yjs relative
-- positions in the page's live document plus the quoted text, so it follows
-- edits; a discussion is resolved once its outcome is written into the page.
ALTER TABLE data.page_links ADD COLUMN anchor_json JSONB;
ALTER TABLE data.page_links ADD COLUMN resolved_at TIMESTAMPTZ;
ALTER TABLE data.page_links ADD CONSTRAINT page_links_anchor_size
  CHECK (anchor_json IS NULL OR octet_length(anchor_json::text) <= 4096) NOT VALID;
