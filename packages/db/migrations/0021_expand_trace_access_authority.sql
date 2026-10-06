CREATE INDEX trace_access_grants_scope_idx
  ON data.trace_access_grants (
    viewer_user_id, agent_id, status, duration, channel_id, instance_id
  );

CREATE INDEX trace_access_grants_active_expiry_idx
  ON data.trace_access_grants (expires_at, grant_id)
  WHERE status IN ('pending', 'approved') AND expires_at IS NOT NULL;

CREATE INDEX trace_access_grants_active_instance_idx
  ON data.trace_access_grants (instance_id, grant_id)
  WHERE status IN ('pending', 'approved') AND instance_id IS NOT NULL;
