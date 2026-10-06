-- A wake is not a reborn (docs/instance-sleep.md §3). Both resume the same
-- Instance through one durable continuation, but a wake answers no message:
-- its failure is the Instance's own state, not a Channel notice. NULL `kind`
-- is an intent written before this column: a reborn or a handoff.
--
-- `wake_failed` keeps an Instance whose wake failed visible in its Channel
-- with the reason; no later message retries it, an explicit `:reborn` does.

-- Fail fast instead of queueing Runtime traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.agent_reborn_intents ADD COLUMN kind TEXT
  CHECK (kind IS NULL OR kind IN ('reborn', 'handoff', 'wake'));

ALTER TABLE data.instances ADD COLUMN rest_reason TEXT
  CHECK (rest_reason IS NULL OR length(rest_reason) <= 200);
ALTER TABLE data.instances
  DROP CONSTRAINT instances_rest_state_check,
  ADD CONSTRAINT instances_rest_state_check CHECK (
    rest_state IS NULL OR rest_state IN ('sleeping', 'interrupted', 'stopped', 'wake_failed')
  ) NOT VALID;
ALTER TABLE data.instances VALIDATE CONSTRAINT instances_rest_state_check;
