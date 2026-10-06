-- Permission withdrawal is durable even while the physical host is offline.
-- This private execution record is not an Agent identity or public message.
CREATE TABLE data.registration_stop_intents (
  run_id TEXT PRIMARY KEY REFERENCES data.runs(run_id),
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  host_id TEXT NOT NULL CHECK (length(host_id) BETWEEN 1 AND 160),
  execution_key TEXT NOT NULL CHECK (length(execution_key) BETWEEN 1 AND 300),
  allocation_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  control_id TEXT NOT NULL UNIQUE,
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation >= 1),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed')),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK ((state='completed')=(completed_at IS NOT NULL)),
  FOREIGN KEY (space_id,owner_user_id,machine_id,harness)
    REFERENCES data.space_agent_registrations(space_id,owner_user_id,machine_id,harness)
);
CREATE INDEX registration_stop_pending_idx ON data.registration_stop_intents(next_attempt_at,run_id)
  WHERE state='pending';
