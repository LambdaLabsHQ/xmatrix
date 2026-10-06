ALTER TABLE data.agent_launches
  ADD COLUMN trigger_committed_at TIMESTAMPTZ,
  ADD COLUMN interpret_started_at TIMESTAMPTZ,
  ADD COLUMN prepared_at TIMESTAMPTZ,
  ADD COLUMN command_durable_at TIMESTAMPTZ,
  ADD COLUMN wake_requested_at TIMESTAMPTZ,
  ADD COLUMN admitted_at TIMESTAMPTZ,
  ADD COLUMN spawned_at TIMESTAMPTZ,
  ADD COLUMN connected_at TIMESTAMPTZ,
  ADD COLUMN last_reconciled_at TIMESTAMPTZ;

CREATE INDEX agent_launches_machine_delivery_idx
  ON data.agent_launches (owner_user_id, machine_id, host_id, next_attempt_at, launch_id)
  WHERE state IN ('prepared', 'queued');

CREATE INDEX agent_launches_reconcile_idx
  ON data.agent_launches (last_reconciled_at, launch_id)
  WHERE state IN ('queued', 'admitted', 'spawned');

CREATE INDEX workspaces_agent_launch_path_idx
  ON data.workspaces (
    owner_user_id,
    machine_id,
    lower(rtrim(replace(canonical_cwd, chr(92), '/'), '/'))
  );

CREATE INDEX workspaces_agent_launch_remote_idx
  ON data.workspaces (
    owner_user_id,
    machine_id,
    lower(regexp_replace(COALESCE(metadata_json->>'gitRemote', ''), '\.git/?$', ''))
  );
