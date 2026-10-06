-- The provider windows (5h, weekly…) behind a quota observation, for display on
-- the Agents page. `remaining` stays the routing fact; NULL is a reading that
-- predates windows.

-- Fail fast instead of queueing quota writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE control.registration_quota_observations ADD COLUMN windows_json JSONB
  CHECK (windows_json IS NULL OR (jsonb_typeof(windows_json) = 'array' AND jsonb_array_length(windows_json) <= 8));
