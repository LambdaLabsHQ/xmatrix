-- A daemon's terminal Run report is durable before the daemon is answered.
-- The Agent Launch coordinator finalizes the Run's lifecycle and follow-ups
-- from this record, so the report frame itself stays one short transaction.
CREATE TABLE data.machine_run_terminal_reports (
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 300),
  event_type TEXT NOT NULL CHECK (event_type IN ('machine_run_exited','machine_stop_result')),
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  owner_email TEXT NOT NULL,
  machine_id TEXT NOT NULL CHECK (length(machine_id) BETWEEN 1 AND 160),
  host_id TEXT NOT NULL CHECK (length(host_id) BETWEEN 1 AND 160),
  host_name TEXT,
  channel_id TEXT NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 300),
  connection_epoch BIGINT NOT NULL CHECK (connection_epoch >= 1),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 300),
  payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  stop_purpose TEXT CHECK (stop_purpose IS NULL OR stop_purpose = 'reborn-predecessor'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','finalized')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finalized_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, event_type),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK ((state = 'finalized') = (finalized_at IS NOT NULL))
);
CREATE INDEX machine_run_terminal_reports_pending_idx
  ON data.machine_run_terminal_reports (next_attempt_at, run_id, event_type) WHERE state = 'pending';
CREATE INDEX machine_run_terminal_reports_finalized_idx
  ON data.machine_run_terminal_reports (finalized_at) WHERE state = 'finalized';
