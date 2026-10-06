-- Why an offline Instance is offline (docs/instance-sleep.md §1). `sleeping`
-- and `interrupted` Instances are woken by the next message in their Channel;
-- a `stopped` one only by an explicit reborn. NULL is a live Instance, one that
-- went offline before rest states existed, or one whose Run was never
-- resumable; none of those is woken.

-- Fail fast instead of queueing Runtime traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.instances ADD COLUMN rest_state TEXT
  CHECK (rest_state IS NULL OR rest_state IN ('sleeping', 'interrupted', 'stopped'));

-- Wake and presence read a Channel's resting Instances, newest first.
CREATE INDEX instances_resting_channel_idx ON data.instances (channel_id, updated_at DESC)
  WHERE rest_state IN ('sleeping', 'interrupted');
