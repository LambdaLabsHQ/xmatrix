-- Observation-only columns replace legacy host identity terminology.
-- Their absence never changes owner, Machine, Run or execution authority.
ALTER TABLE data.agent_launches ADD COLUMN hostname TEXT;
ALTER TABLE data.agent_reborn_intents ADD COLUMN hostname TEXT;
ALTER TABLE data.machine_daemon_commands ADD COLUMN hostname TEXT;
ALTER TABLE data.machine_run_routes ADD COLUMN hostname TEXT;
ALTER TABLE data.machine_run_snapshot_heads ADD COLUMN hostname TEXT;
ALTER TABLE data.machine_run_terminal_reports ADD COLUMN hostname TEXT;
ALTER TABLE data.registration_stop_intents ADD COLUMN hostname TEXT;
