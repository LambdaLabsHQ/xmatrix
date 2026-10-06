-- Staging owns only the distributed preparation attempt. Existing Runs and
-- Launches remain the sole lifecycle and machine-delivery authorities.
CREATE TABLE data.registration_launch_intents (
  actor_user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  selection_index INTEGER NOT NULL CHECK (selection_index BETWEEN 0 AND 31),
  source_body_hash TEXT NOT NULL CHECK (source_body_hash ~ '^[a-f0-9]{64}$'),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 1),
  run_id TEXT NOT NULL UNIQUE,
  instance_id TEXT NOT NULL UNIQUE,
  launch_id TEXT NOT NULL UNIQUE,
  execution_key TEXT NOT NULL UNIQUE,
  control_id TEXT NOT NULL UNIQUE,
  authorization_digest TEXT NOT NULL CHECK (authorization_digest ~ '^[a-f0-9]{64}$'),
  grant_revision BIGINT NOT NULL,
  grant_execution_revision BIGINT NOT NULL,
  policy_revision BIGINT NOT NULL,
  policy_execution_revision BIGINT NOT NULL,
  resources_json JSONB NOT NULL CHECK (jsonb_typeof(resources_json)='object'),
  configuration_json JSONB NOT NULL CHECK (jsonb_typeof(configuration_json)='object'),
  display_name TEXT NOT NULL,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  allocation_id TEXT,
  cancellation_completed BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL CHECK (state IN ('preparing','committed','aborted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id,command_id),
  FOREIGN KEY (space_id,owner_user_id,machine_id,harness)
    REFERENCES data.space_agent_registrations(space_id,owner_user_id,machine_id,harness)
);
CREATE INDEX registration_launch_preparing_idx ON data.registration_launch_intents
  (space_id,owner_user_id,machine_id,harness,created_at) WHERE state='preparing';
CREATE UNIQUE INDEX registration_launch_source_idx ON data.registration_launch_intents
  (channel_id,source_message_id,selection_index) WHERE state <> 'aborted';

-- A durable abort fences a reservation that may arrive after a lost response.
-- This is a Run preparation fact, not a registration identifier or permission.
CREATE TABLE control.registration_preparation_cancellations (
  run_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  source_command_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
