-- Quota probes use the existing owner-scoped machine command lease. Old
-- daemons do not advertise or claim this command; no launch authority changes.
ALTER TABLE data.machine_daemon_commands
  DROP CONSTRAINT machine_daemon_commands_command_type_check,
  ADD CONSTRAINT machine_daemon_commands_command_type_check
    CHECK (command_type IN ('spawn','stop','cleanup','request_resolve','recover_reply','quota_probe')) NOT VALID;
