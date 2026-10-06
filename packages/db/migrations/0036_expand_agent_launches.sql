CREATE TABLE data.agent_launches (
  launch_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  target_profile_id TEXT NOT NULL,
  launch_kind TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  instance_id TEXT NOT NULL UNIQUE,
  execution_key TEXT NOT NULL UNIQUE,
  control_id TEXT NOT NULL UNIQUE,
  machine_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'queued', 'admitted', 'spawned', 'connected', 'failed', 'cancelled'
  )),
  spawn_payload_json JSONB NOT NULL CHECK (jsonb_typeof(spawn_payload_json) = 'object'),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  error_stage TEXT,
  error_code TEXT,
  error_message TEXT,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  daemon_offline BOOLEAN NOT NULL DEFAULT TRUE,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  first_reply_at TIMESTAMPTZ,
  CHECK (length(launch_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(trigger_id) BETWEEN 1 AND 300),
  CHECK (length(target_profile_id) BETWEEN 1 AND 300),
  CHECK (length(launch_kind) BETWEEN 1 AND 80),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(machine_id) BETWEEN 1 AND 160),
  CHECK (length(host_id) BETWEEN 1 AND 160),
  CHECK (pg_column_size(spawn_payload_json) <= 262144),
  CHECK (error_message IS NULL OR octet_length(error_message) <= 2000),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK (updated_at >= created_at),
  UNIQUE (channel_id, trigger_id, target_profile_id, launch_kind)
);

CREATE INDEX agent_launches_coordinator_idx
  ON data.agent_launches (next_attempt_at, launch_id)
  WHERE state IN ('prepared', 'queued', 'admitted', 'spawned');

CREATE INDEX agent_launches_channel_trigger_idx
  ON data.agent_launches (channel_id, trigger_id, created_at, launch_id);

CREATE INDEX runtime_starting_runs_reconcile_idx
  ON data.runs (created_at, run_id)
  WHERE status = 'starting';
