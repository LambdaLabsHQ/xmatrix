-- Durable stop-to-spawn continuity. Runtime/Channel authority owns these facts;
-- the existing Launch coordinator only advances eligible work.
CREATE TABLE data.agent_reborn_intents (
  intent_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  successor_run_id TEXT NOT NULL UNIQUE,
  stop_control_id TEXT NOT NULL UNIQUE,
  machine_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  stop_required BOOLEAN NOT NULL,
  stop_payload_json JSONB NOT NULL,
  run_input_json JSONB NOT NULL,
  instance_input_json JSONB NOT NULL,
  spawn_payload_json JSONB NOT NULL,
  source_cancellation_json JSONB NOT NULL DEFAULT 'null'::jsonb,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','prepared','spawned','failed')),
  error_code TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_until TIMESTAMPTZ,
  lease_owner TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK ((lease_until IS NULL) = (lease_owner IS NULL)),
  CHECK (pg_column_size(run_input_json) <= 262144),
  CHECK (pg_column_size(spawn_payload_json) <= 262144)
);
CREATE UNIQUE INDEX agent_reborn_source_waiting_idx ON data.agent_reborn_intents(source_instance_id)
  WHERE state IN ('waiting','prepared');
CREATE INDEX agent_reborn_due_idx ON data.agent_reborn_intents(next_attempt_at,intent_id)
  WHERE state IN ('waiting','prepared');
