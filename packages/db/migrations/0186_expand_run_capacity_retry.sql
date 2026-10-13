-- One Hub-owned capacity recovery per Run. Provider reports cannot write these
-- columns through Run metadata, and Run deletion/movement carries them with it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.runs ADD COLUMN capacity_retry_json JSONB,
  ADD COLUMN capacity_retry_at TIMESTAMPTZ;
ALTER TABLE data.runs ADD CONSTRAINT runs_capacity_retry_object
  CHECK (capacity_retry_json IS NULL OR jsonb_typeof(capacity_retry_json)='object') NOT VALID;
CREATE INDEX runs_capacity_retry_due_idx ON data.runs (channel_id, capacity_retry_at, run_id)
  WHERE capacity_retry_at IS NOT NULL;
