-- A person's explicit choice to wait for provider quota. Offers create no work.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.agent_quota_retries (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  retry_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_input_version BIGINT NOT NULL CHECK (source_input_version >= 1),
  source_body_hash TEXT NOT NULL,
  source_sequence BIGINT NOT NULL,
  source_mention TEXT NOT NULL,
  selection_index INTEGER NOT NULL CHECK (selection_index BETWEEN 0 AND 31),
  kind TEXT NOT NULL CHECK (kind IN ('launch','continuation')),
  source_instance_id TEXT,
  source_run_id TEXT,
  registrations_json JSONB NOT NULL CHECK (jsonb_typeof(registrations_json)='array'
    AND jsonb_array_length(registrations_json) BETWEEN 1 AND 100),
  state TEXT NOT NULL DEFAULT 'offered' CHECK (state IN ('offered','waiting','dispatching','dispatched','cancelled','expired','failed')),
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 120),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  next_check_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (channel_id,retry_id),
  UNIQUE (channel_id,source_message_id,source_input_version,selection_index,kind),
  CHECK ((kind='continuation')=(source_instance_id IS NOT NULL AND source_run_id IS NOT NULL))
);
CREATE INDEX agent_quota_retries_due_idx ON data.agent_quota_retries (channel_id,next_check_at,retry_id)
  WHERE next_check_at IS NOT NULL;
CREATE INDEX agent_quota_retries_space_idx ON data.agent_quota_retries (space_id);
