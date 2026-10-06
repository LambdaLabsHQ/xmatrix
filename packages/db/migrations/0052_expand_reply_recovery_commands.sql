-- Widen the existing command vocabulary atomically. Every old value remains
-- valid; the new intent only recovers an existing Run-scoped reply operation.
ALTER TABLE data.machine_daemon_commands
  DROP CONSTRAINT machine_daemon_commands_command_type_check,
  ADD CONSTRAINT machine_daemon_commands_command_type_check
    CHECK (command_type IN ('spawn','stop','cleanup','request_resolve','recover_reply')) NOT VALID;
