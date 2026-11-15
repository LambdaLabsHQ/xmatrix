-- Quota by account and model. A pool's reading has two parts, each fenced on
-- its own read time:
--   the account part: `windows_json` (account windows, which constrain every
--   model), `observed_at`, `expires_at`, `account_json`, `remaining`, `source`
--   as before. Every reading renews it, a complete one or a partial one (a
--   Claude rate-limit verdict). `remaining` is the account's own headroom; a
--   usage-limit hold without windows (`source='daemon'`) is still a zero
--   `remaining` until `expires_at`.
--   the scoped part, added here: windows that each constrain only the models
--   whose catalog row lists their `scope` (Claude's per-model week, Cursor's
--   Auto and API pools), when they were read, and when the last of them stops
--   counting. Only a complete reading renews it.
-- The row is current while either part is. A Hub that predates this reads the
-- account part alone, as it did.

-- Fail fast instead of queueing quota writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE control.registration_quota_observations ADD COLUMN scoped_windows_json JSONB
  CHECK (scoped_windows_json IS NULL OR (jsonb_typeof(scoped_windows_json) = 'array'
    AND jsonb_array_length(scoped_windows_json) <= 8));
ALTER TABLE control.registration_quota_observations ADD COLUMN scoped_observed_at TIMESTAMPTZ;
ALTER TABLE control.registration_quota_observations ADD COLUMN scoped_expires_at TIMESTAMPTZ
  CHECK (scoped_expires_at IS NULL OR scoped_expires_at > scoped_observed_at);
