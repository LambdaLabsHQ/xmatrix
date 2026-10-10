-- A text task (an instruction and the text it is about, answered by a fresh
-- harness process) uses the existing owner-scoped machine command lease. Old
-- daemons do not advertise or claim this command type.

-- Fail fast instead of queueing machine command writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.machine_daemon_commands
  DROP CONSTRAINT machine_daemon_commands_command_type_check,
  ADD CONSTRAINT machine_daemon_commands_command_type_check
    CHECK (command_type IN ('spawn','stop','cleanup','request_resolve','recover_reply','quota_probe','harness_action','worktree_action','text_task')) NOT VALID;
