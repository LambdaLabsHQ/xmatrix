-- A call an Agent made names that Agent, as it was called when it ran, beside
-- the person it ran for.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.app_connector_executions
  ADD COLUMN requested_by_agent TEXT CHECK (requested_by_agent IS NULL OR length(requested_by_agent) BETWEEN 1 AND 120);
