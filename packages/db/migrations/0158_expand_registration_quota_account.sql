-- The provider's verdict on the account read together with its windows:
-- `allowed` (it still serves the account, e.g. on credits past a used-up
-- window) and the credit balance. NULL is a reading without one.

-- Fail fast instead of queueing quota writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE control.registration_quota_observations ADD COLUMN account_json JSONB
  CHECK (account_json IS NULL OR jsonb_typeof(account_json) = 'object');
