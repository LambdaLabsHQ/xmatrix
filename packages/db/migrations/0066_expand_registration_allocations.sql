-- Allocation IDs belong to startup attempts, not to registrations. A failed
-- pre-commit attempt may be replaced; its late admission remains fenced.
CREATE TABLE control.registration_execution_allocations (
  allocation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  source_command_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  authorization_digest TEXT NOT NULL CHECK (authorization_digest ~ '^[a-f0-9]{64}$'),
  requirements_json JSONB NOT NULL CHECK (jsonb_typeof(requirements_json) = 'object'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  environment_version BIGINT NOT NULL CHECK (environment_version >= 1),
  runtime_model TEXT NOT NULL CHECK (length(runtime_model) BETWEEN 1 AND 160),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'admitted', 'stopping', 'released')),
  daemon_id TEXT,
  connection_epoch BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  admitted_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT CHECK (release_reason IN ('preparation_aborted', 'cancelled_before_start', 'process_terminal')),
  UNIQUE (run_id, generation),
  FOREIGN KEY (owner_user_id,machine_id,harness)
    REFERENCES control.agent_registration_environments (owner_user_id,machine_id,harness),
  CHECK ((state='released') = (released_at IS NOT NULL AND release_reason IS NOT NULL)),
  CHECK (state NOT IN ('admitted','stopping') OR (daemon_id IS NOT NULL AND connection_epoch >= 1 AND admitted_at IS NOT NULL))
);
CREATE UNIQUE INDEX registration_allocation_active_run_idx
  ON control.registration_execution_allocations (run_id) WHERE state <> 'released';
CREATE INDEX registration_allocation_capacity_idx
  ON control.registration_execution_allocations (owner_user_id,machine_id,harness,state)
  WHERE state <> 'released';
