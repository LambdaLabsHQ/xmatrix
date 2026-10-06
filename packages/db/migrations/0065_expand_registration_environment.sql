-- These tables are global control facts. No Space-local configuration can
-- overwrite physical availability, provider bindings or shared execution limits.
CREATE TABLE control.machine_execution_capacity (
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent BETWEEN 1 AND 32),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id, machine_id)
);

CREATE TABLE control.agent_registration_environments (
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  declaration_json JSONB NOT NULL CHECK (jsonb_typeof(declaration_json) = 'object'),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id, machine_id, harness),
  FOREIGN KEY (owner_user_id, machine_id, harness)
    REFERENCES data.agent_registrations (owner_user_id, machine_id, harness),
  FOREIGN KEY (owner_user_id, machine_id)
    REFERENCES control.machine_execution_capacity (owner_user_id, machine_id)
);

CREATE TABLE control.agent_environment_commands (
  actor_user_id TEXT NOT NULL,
  command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 200),
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result_version BIGINT NOT NULL CHECK (result_version >= 1),
  result_machine_version BIGINT NOT NULL CHECK (result_machine_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id, command_id),
  CHECK (actor_user_id=owner_user_id),
  FOREIGN KEY (owner_user_id, machine_id, harness)
    REFERENCES control.agent_registration_environments (owner_user_id, machine_id, harness)
);
