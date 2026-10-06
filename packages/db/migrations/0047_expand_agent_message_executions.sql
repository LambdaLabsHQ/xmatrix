-- Message-specific runtime reports are product facts, separate from mutable
-- Run metadata and live presence. Source content is never copied here.
CREATE TABLE data.agent_message_executions (
  binding_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL,
  agent_name TEXT,
  channel_instance_id TEXT,
  execution_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
  report_digest TEXT NOT NULL CHECK (length(report_digest) = 64),
  source_message_id TEXT NOT NULL,
  source_entity_version BIGINT NOT NULL CHECK (source_entity_version > 0),
  source_body_hash TEXT NOT NULL CHECK (length(source_body_hash) = 64),
  source_sequence BIGINT NOT NULL CHECK (source_sequence > 0),
  source_count INTEGER NOT NULL CHECK (source_count BETWEEN 1 AND 100),
  state TEXT NOT NULL CHECK (state IN ('accepted','running','completed','failed','interrupted','unknown')),
  input_disposition TEXT CHECK (input_disposition IN ('pending','submitted','resumed_existing')),
  started_at_millis BIGINT NOT NULL CHECK (started_at_millis >= 0),
  updated_at_millis BIGINT NOT NULL CHECK (updated_at_millis >= started_at_millis),
  finished_at_millis BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, execution_id, source_message_id),
  CHECK (finished_at_millis IS NULL OR finished_at_millis BETWEEN started_at_millis AND updated_at_millis),
  CHECK (expires_at > created_at)
);

CREATE INDEX agent_message_execution_source_page_idx ON data.agent_message_executions
  (channel_id, source_message_id, created_at, binding_id);
CREATE INDEX agent_message_execution_expiry_idx ON data.agent_message_executions
  (expires_at, binding_id);
