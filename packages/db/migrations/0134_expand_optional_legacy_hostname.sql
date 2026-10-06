-- Legacy observations are optional before their readers and writers retire.
-- Machine, Run, execution and owner constraints remain mandatory.
ALTER TABLE data.agent_launches ALTER COLUMN host_id DROP NOT NULL;
ALTER TABLE data.agent_reborn_intents ALTER COLUMN host_id DROP NOT NULL;
ALTER TABLE data.machine_daemon_commands ALTER COLUMN host_id DROP NOT NULL;
ALTER TABLE data.machine_daemons ALTER COLUMN host_id DROP NOT NULL;
ALTER TABLE data.machine_run_routes ALTER COLUMN host_id DROP NOT NULL;
ALTER TABLE data.machine_run_terminal_reports ALTER COLUMN host_id DROP NOT NULL;
