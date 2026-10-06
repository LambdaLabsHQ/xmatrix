-- Global enrollment replay lives on the directory connection, independently
-- from the Space's configuration command. A failed sharing step may be retried
-- without creating a second physical registration or widening a Space grant.
CREATE TABLE control.agent_registration_enrollments (
  owner_user_id TEXT NOT NULL,
  command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 200),
  space_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id, command_id),
  FOREIGN KEY (owner_user_id, machine_id, harness)
    REFERENCES data.agent_registrations (owner_user_id, machine_id, harness)
);
