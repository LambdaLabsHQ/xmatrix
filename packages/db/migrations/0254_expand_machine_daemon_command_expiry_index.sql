-- xmatrix:online-indexes
-- Daily lifecycle maintenance removes Machine daemon commands a week after
-- they expire. No index led with expires_at, so each bounded batch would have
-- scanned the whole command table (about 440 MB on 2026-11-15) under its
-- five-second statement timeout. This index makes every batch an ordered,
-- bounded range read of the oldest expired commands.
CREATE INDEX CONCURRENTLY machine_daemon_commands_expiry_idx
  ON data.machine_daemon_commands (expires_at, command_id);
