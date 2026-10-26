-- xmatrix:online-indexes
CREATE INDEX CONCURRENTLY messages_admin_metadata_idx
  ON data.messages (author_kind, author_id, created_at)
  INCLUDE (space_id)
  WHERE deleted_at IS NULL;
CREATE INDEX CONCURRENTLY messages_admin_agent_activity_idx
  ON data.messages ((preview_json#>>'{senderSnapshot,userId}'), created_at DESC)
  INCLUDE (space_id)
  WHERE deleted_at IS NULL AND author_kind = 'agent';
CREATE INDEX CONCURRENTLY messages_admin_legacy_agent_activity_idx
  ON data.messages (author_id, space_id, created_at DESC)
  WHERE deleted_at IS NULL AND author_kind = 'agent' AND preview_json IS NULL;
