ALTER TABLE data.machine_daemon_commands
  ADD COLUMN lease_owner TEXT;

ALTER TABLE data.machine_daemon_commands
  ADD COLUMN lease_generation BIGINT;

ALTER TABLE data.machine_daemon_commands
  ADD COLUMN available_at TIMESTAMPTZ;

ALTER TABLE data.machine_daemon_commands
  ADD COLUMN expires_at TIMESTAMPTZ;

ALTER TABLE data.machine_daemon_commands
  ADD COLUMN completed_at TIMESTAMPTZ;

ALTER TABLE data.machine_daemon_commands
  ADD CONSTRAINT machine_daemon_commands_lease_generation_nonnegative
  CHECK (lease_generation IS NULL OR lease_generation >= 0) NOT VALID;

ALTER TABLE data.machine_daemon_commands
  ADD CONSTRAINT machine_daemon_commands_lease_shape
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    OR
    (status <> 'leased' AND lease_owner IS NULL AND lease_until IS NULL)
  ) NOT VALID;

CREATE INDEX machine_daemon_commands_dispatch_idx
  ON data.machine_daemon_commands
    (owner_user_id, machine_id, host_id, status, available_at, created_at, command_id);
