-- A quota retry knows the reading that refused it, so only a newer reading
-- can start it, and an original summon is still being checked (and so starts
-- on its own when a reading clears it) until `verify_until`. A continuation
-- never sets it: recovering a stopped Instance stays an explicit choice.
-- `wake_revision` moves with every wake (NULL is none yet), so a check that
-- began before a wake cannot put the retry back to sleep.

-- Fail fast instead of queueing launches behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.agent_quota_retries ADD COLUMN refused_through TIMESTAMPTZ;
ALTER TABLE data.agent_quota_retries ADD COLUMN verify_until TIMESTAMPTZ;
ALTER TABLE data.agent_quota_retries ADD COLUMN wake_revision BIGINT;
