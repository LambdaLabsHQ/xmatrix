-- An owner removes a Machine from their account. The row stays so history keeps
-- its name; while retired_at is set the Machine is hidden, its registrations'
-- Runs are stopped, and its daemon may not enroll or connect until the owner
-- logs in on it again.

-- Fail fast instead of queueing Machine writes behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.machines ADD COLUMN retired_at TIMESTAMPTZ;
