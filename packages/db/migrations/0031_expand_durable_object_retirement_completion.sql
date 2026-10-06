ALTER TABLE control.durable_object_empty_shell_retirement_receipts
  ADD COLUMN completed_app_revision TEXT;

ALTER TABLE control.durable_object_empty_shell_retirement_receipts
  ADD COLUMN completed_worker_version TEXT;

ALTER TABLE control.durable_object_empty_shell_retirement_receipts
  ADD CONSTRAINT durable_object_empty_shell_retirement_completion_check CHECK (
    (state = 'prepared' AND completed_app_revision IS NULL AND completed_worker_version IS NULL) OR
    (state = 'complete' AND completed_app_revision ~ '^[0-9a-f]{40}$'
      AND length(completed_worker_version) BETWEEN 1 AND 200)
  ) NOT VALID;

ALTER TABLE control.durable_object_empty_shell_retirement_receipts
  VALIDATE CONSTRAINT durable_object_empty_shell_retirement_completion_check;
