-- Commands audit natural registration keys; command IDs are lifecycle/replay
-- identifiers, never surrogate registration identities.
CREATE TABLE data.agent_registration_commands (
  actor_user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  command_kind TEXT NOT NULL CHECK (command_kind IN ('offer', 'configure')),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  result_version BIGINT NOT NULL CHECK (result_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id, command_id),
  FOREIGN KEY (space_id, owner_user_id, machine_id, harness)
    REFERENCES data.space_agent_registrations (space_id, owner_user_id, machine_id, harness),
  CHECK (length(actor_user_id) BETWEEN 1 AND 300),
  CHECK (length(command_id) BETWEEN 1 AND 200)
);
