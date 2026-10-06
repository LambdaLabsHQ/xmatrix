-- M1 of the Automation storage rename: the PostgreSQL tables that hold
-- Automations stop saying "scheduled task".
--
-- The migrator runs this file inside one transaction, so the renames and the
-- compatibility views become visible together or not at all.
--
-- Renaming a column keeps its ordinal position, and CHECK/UNIQUE/PRIMARY KEY
-- constraints follow the column, so every constraint keeps enforcing the same
-- rule. Renaming a PRIMARY KEY or UNIQUE constraint also renames the index it
-- owns; the remaining plain indexes are renamed directly.

-- Renames take ACCESS EXCLUSIVE locks. Fail fast instead of queueing every
-- Automation read behind a long-running transaction; the operator re-runs.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.scheduled_tasks RENAME TO automations;
ALTER TABLE data.automations RENAME COLUMN task_id TO automation_id;

ALTER TABLE data.automations RENAME CONSTRAINT scheduled_tasks_pkey TO automations_pkey;
ALTER TABLE data.automations
  RENAME CONSTRAINT scheduled_tasks_task_id_check TO automations_automation_id_check;
ALTER TABLE data.automations
  RENAME CONSTRAINT scheduled_tasks_owner_user_id_check TO automations_owner_user_id_check;
ALTER TABLE data.automations
  RENAME CONSTRAINT scheduled_tasks_channel_id_check TO automations_channel_id_check;
ALTER TABLE data.automations
  RENAME CONSTRAINT scheduled_tasks_version_check TO automations_version_check;
ALTER TABLE data.automations
  RENAME CONSTRAINT scheduled_tasks_payload_json_check TO automations_payload_json_check;
ALTER TABLE data.automations
  RENAME CONSTRAINT scheduled_tasks_payload_json_check1 TO automations_payload_json_check1;
ALTER TABLE data.automations
  RENAME CONSTRAINT scheduled_tasks_run_count_check TO automations_run_count_check;
ALTER TABLE data.automations RENAME CONSTRAINT scheduled_tasks_check TO automations_check;
ALTER INDEX data.scheduled_tasks_due_idx RENAME TO automations_due_idx;

ALTER TABLE data.scheduled_task_occurrences RENAME TO automation_occurrences;
ALTER TABLE data.automation_occurrences RENAME COLUMN task_id TO automation_id;
ALTER TABLE data.automation_occurrences RENAME COLUMN task_version TO automation_version;

ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_pkey TO automation_occurrences_pkey;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_run_id_key TO automation_occurrences_run_id_key;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_instance_id_key
    TO automation_occurrences_instance_id_key;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_control_id_key
    TO automation_occurrences_control_id_key;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_task_id_scheduled_for_key
    TO automation_occurrences_automation_id_scheduled_for_key;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_occurrence_id_check
    TO automation_occurrences_occurrence_id_check;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_task_version_check
    TO automation_occurrences_automation_version_check;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_status_check TO automation_occurrences_status_check;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_attempts_check
    TO automation_occurrences_attempts_check;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_check TO automation_occurrences_check;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_check1 TO automation_occurrences_check1;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_delivery_kind_check
    TO automation_occurrences_delivery_kind_check;
ALTER TABLE data.automation_occurrences
  RENAME CONSTRAINT scheduled_task_occurrences_execution_timeout_check
    TO automation_occurrences_execution_timeout_check;
ALTER INDEX data.scheduled_task_occurrences_due_idx RENAME TO automation_occurrences_due_idx;
ALTER INDEX data.scheduled_task_occurrences_task_idx
  RENAME TO automation_occurrences_automation_idx;
ALTER INDEX data.scheduled_task_occurrences_message_idx
  RENAME TO automation_occurrences_message_idx;
ALTER INDEX data.scheduled_task_occurrences_live_idx RENAME TO automation_occurrences_live_idx;
ALTER INDEX data.scheduled_task_occurrences_timeout_idx
  RENAME TO automation_occurrences_timeout_idx;

-- An index keeps the column names it was built with, so the indexes over the
-- renamed columns are renamed to match what a fresh CREATE INDEX would record.
ALTER TABLE data.automations_pkey RENAME COLUMN task_id TO automation_id;
ALTER TABLE data.automations_due_idx RENAME COLUMN task_id TO automation_id;
ALTER TABLE data.automation_occurrences_automation_id_scheduled_for_key
  RENAME COLUMN task_id TO automation_id;
ALTER TABLE data.automation_occurrences_automation_idx RENAME COLUMN task_id TO automation_id;

-- Compatibility views for the Hub that is deployed while this migration lands.
-- That Hub still reads and writes data.scheduled_tasks(task_id) and
-- data.scheduled_task_occurrences(task_id, task_version). Each view exposes
-- the original column names in the original column order, so SELECT * rows are
-- unchanged, and each stays a simple single-table view without expressions, so
-- PostgreSQL keeps it automatically updatable for INSERT (including
-- ON CONFLICT), UPDATE ... RETURNING, DELETE and SELECT ... FOR UPDATE.
-- A later contract migration drops both views once no deployed Hub uses them.
CREATE VIEW data.scheduled_tasks AS
  SELECT automation_id AS task_id, owner_user_id, channel_id, next_run_at, enabled, version,
    payload_json, run_count, last_run_at, last_run_id, last_error, created_at, updated_at
  FROM data.automations;

CREATE VIEW data.scheduled_task_occurrences AS
  SELECT occurrence_id, automation_id AS task_id, automation_version AS task_version,
    owner_user_id, scheduled_for, status, lease_owner, lease_until, attempts, next_attempt_at,
    run_id, instance_id, control_id, error_code, error_message, created_at, updated_at,
    finished_at, delivery_kind, message_id, execution_timeout_ms, execution_deadline_at
  FROM data.automation_occurrences;

COMMENT ON VIEW data.scheduled_tasks IS
  'Transitional compatibility view over data.automations for the previously deployed Hub.';
COMMENT ON VIEW data.scheduled_task_occurrences IS
  'Transitional compatibility view over data.automation_occurrences for the previously deployed Hub.';
