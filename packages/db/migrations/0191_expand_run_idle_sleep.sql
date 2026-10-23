-- When the Hub next owes a resting Run its sleep (docs/instance-sleep.md). Set
-- when the Run starts resting, cleared when it works again or when its sleep
-- is issued; the Channel coordinator wakes at the earliest one.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.runs ADD COLUMN idle_sleep_at TIMESTAMPTZ;
CREATE INDEX runs_idle_sleep_due_idx ON data.runs (channel_id, idle_sleep_at, run_id)
  WHERE idle_sleep_at IS NOT NULL;
