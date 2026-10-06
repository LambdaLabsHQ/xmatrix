ALTER TABLE data.scheduled_task_occurrences
  ADD COLUMN delivery_kind TEXT;

ALTER TABLE data.scheduled_task_occurrences
  ADD COLUMN message_id TEXT;

ALTER TABLE data.scheduled_task_occurrences
  ADD COLUMN execution_timeout_ms BIGINT;

ALTER TABLE data.scheduled_task_occurrences
  ADD COLUMN execution_deadline_at TIMESTAMPTZ;

ALTER TABLE data.scheduled_task_occurrences
  ADD CONSTRAINT scheduled_task_occurrences_delivery_kind_check
    CHECK (delivery_kind IS NULL OR delivery_kind IN ('agent_run', 'message')) NOT VALID,
  ADD CONSTRAINT scheduled_task_occurrences_execution_timeout_check
    CHECK (execution_timeout_ms IS NULL OR execution_timeout_ms BETWEEN 1000 AND 86400000) NOT VALID;

CREATE UNIQUE INDEX scheduled_task_occurrences_message_idx
  ON data.scheduled_task_occurrences (message_id) WHERE message_id IS NOT NULL;

CREATE INDEX scheduled_task_occurrences_live_idx
  ON data.scheduled_task_occurrences (status, finished_at, next_attempt_at, occurrence_id);

CREATE INDEX scheduled_task_occurrences_timeout_idx
  ON data.scheduled_task_occurrences (
    status, finished_at, execution_deadline_at, next_attempt_at, occurrence_id
  );
