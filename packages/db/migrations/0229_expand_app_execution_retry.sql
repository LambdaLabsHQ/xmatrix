-- A failed execution says how to fix it and how to run it again: its remedy
-- (sign in, reconnect or replace one credential), the read command it ran,
-- and whether that command's result was private.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.app_connector_executions
  ADD COLUMN remedy TEXT CHECK (remedy IS NULL OR remedy ~ '^(reconnect|credential:[A-Za-z0-9_]{1,80})$'),
  ADD COLUMN retry_command TEXT CHECK (retry_command IS NULL OR length(retry_command) BETWEEN 1 AND 4000),
  ADD COLUMN result_visibility TEXT CHECK (result_visibility IS NULL OR result_visibility IN ('public', 'private'));
