-- Explicit per-request approval without widening existing allow/deny overrides.
SET LOCAL lock_timeout = '5s';
-- Old writers advance version and therefore invalidate ask_version; old executors
-- see deny and fail closed. No existing constraint or row is rewritten.
ALTER TABLE data.app_connector_action_policies ADD COLUMN ask_version BIGINT CHECK (ask_version >= 1);

CREATE TABLE data.app_connector_action_requests (
  request_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  connection_generation TEXT NOT NULL,
  credential_version BIGINT NOT NULL,
  encrypted_value_json JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'blocked', 'denied', 'expired')),
  decided_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX app_connector_action_requests_pending_idx
  ON data.app_connector_action_requests (channel_id, created_at) WHERE status='pending';
CREATE INDEX app_connector_action_requests_space_idx ON data.app_connector_action_requests (space_id);
