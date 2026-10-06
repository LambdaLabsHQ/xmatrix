ALTER TABLE data.app_connector_executions
  ADD COLUMN dispatch_state TEXT;

ALTER TABLE data.app_connector_executions
  ADD CONSTRAINT app_connector_execution_dispatch_state_valid
  CHECK (dispatch_state IS NULL OR dispatch_state IN ('pending', 'terminal')) NOT VALID;

ALTER TABLE data.app_connector_executions
  ADD CONSTRAINT app_connector_execution_dispatch_consistent
  CHECK (dispatch_state IS NULL OR
         (status = 'queued' AND dispatch_state = 'pending') OR
         (status <> 'queued' AND dispatch_state = 'terminal')) NOT VALID;

CREATE INDEX app_connector_executions_pending_idx
  ON data.app_connector_executions (space_id, updated_at, execution_id)
  WHERE dispatch_state = 'pending';
