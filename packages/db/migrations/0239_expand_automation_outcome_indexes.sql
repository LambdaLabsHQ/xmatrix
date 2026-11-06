-- xmatrix:online-indexes
-- What a page Automation's occurrences produced is read from each occurrence's
-- own conversation (docs/design/pages-live-document.md §6.4): the page
-- revisions that name it, and its activity entries and failure notices. Both
-- are read by conversation; neither had an index to read them by. Revisions
-- are written a few at a time, so their entries go straight into the index
-- rather than a pending list every read would scan until a vacuum.
CREATE INDEX CONCURRENTLY page_revisions_conversation_idx ON data.page_revisions
  USING gin (conversation_ids) WITH (fastupdate = off);
CREATE INDEX CONCURRENTLY messages_conversation_outcome_idx ON data.messages
  (space_id, channel_id, message_kind, timeline_sequence DESC)
  WHERE message_kind IN ('xmatrix.activity', 'xmatrix.system.runtime-failure') AND deleted_at IS NULL;
