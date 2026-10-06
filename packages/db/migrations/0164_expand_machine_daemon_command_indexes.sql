-- 0137 dropped host_id, and PostgreSQL dropped the indexes that included it.
-- Claim still selects by owner, machine, and status, then orders by created_at.
-- Dispatch still filters available_at for the same key. Recreate both without host_id.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE INDEX machine_daemon_commands_claim_idx
  ON data.machine_daemon_commands
    (owner_user_id, machine_id, status, created_at, command_id);

CREATE INDEX machine_daemon_commands_dispatch_idx
  ON data.machine_daemon_commands
    (owner_user_id, machine_id, status, available_at, created_at, command_id);
