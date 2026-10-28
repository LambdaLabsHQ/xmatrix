-- xmatrix:online-indexes
CREATE INDEX CONCURRENTLY messages_admin_sent_idx
  ON data.messages (sent_at)
  WHERE deleted_at IS NULL;
CREATE INDEX CONCURRENTLY messages_admin_app_events_idx
  ON data.messages (space_id, author_id, created_at)
  INCLUDE (message_id)
  WHERE author_kind = 'app' AND deleted_at IS NULL;
CREATE INDEX CONCURRENTLY app_connector_executions_admin_usage_idx
  ON data.app_connector_executions (space_id, provider_id, connection_id, created_at)
  INCLUDE (status);
