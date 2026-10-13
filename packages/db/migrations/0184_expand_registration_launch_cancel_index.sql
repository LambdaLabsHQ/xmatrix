-- Cancellation reconciliation selects ten unfinished aborts in update order.
-- The channel_open index also retains completed aborts and orders by recheck
-- time, so it cannot bound that scan or avoid sorting a Channel's history.
-- Keep the existing index for preparation and coordinator due-time reads.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '25s';

CREATE INDEX registration_launch_intents_channel_cancel_idx
  ON data.registration_launch_intents (channel_id, updated_at, run_id)
  WHERE state = 'aborted' AND cancellation_completed = FALSE;
