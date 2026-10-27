-- xmatrix:online-indexes
CREATE INDEX CONCURRENTLY messages_admin_sent_idx
  ON data.messages (sent_at)
  WHERE deleted_at IS NULL;
