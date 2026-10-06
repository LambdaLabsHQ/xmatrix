-- A terminal Reborn rejection remains deliverable until Message authority
-- acknowledges its deterministic notice. Failed delivery cannot erase it.
ALTER TABLE data.agent_reborn_intents ADD COLUMN failure_notified_at TIMESTAMPTZ;
CREATE INDEX agent_reborn_failure_notice_due_idx
  ON data.agent_reborn_intents(next_attempt_at,intent_id)
  WHERE state='failed' AND failure_notified_at IS NULL;
