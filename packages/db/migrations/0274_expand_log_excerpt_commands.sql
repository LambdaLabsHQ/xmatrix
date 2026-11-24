-- A person handing a conversation to xMatrix support may preview a recent tail
-- of their own daemon's log first (docs/cross-space-read-grants.md#support-handoffs).
-- The owner asks one of their Machines; its daemon reads and redacts the tail on
-- the machine and answers. Old daemons do not advertise or claim this command type.

-- Fail fast instead of queueing machine command writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.machine_daemon_commands
  DROP CONSTRAINT machine_daemon_commands_command_type_check,
  ADD CONSTRAINT machine_daemon_commands_command_type_check
    CHECK (command_type IN ('spawn','stop','cleanup','request_resolve','recover_reply','quota_probe','harness_action','worktree_action','text_task','sleep','log_excerpt')) NOT VALID;
