-- Each Channel's coordinator reads only its own pending work: when it is next
-- due, and what is due now. These partial indexes keep every such read a
-- bounded range scan on (channel_id, due time), independent of how many
-- Channels or rows exist elsewhere.
CREATE INDEX agent_launches_channel_due_idx ON data.agent_launches (channel_id, next_attempt_at)
  WHERE state IN ('prepared','queued','admitted','spawned','connected');
CREATE INDEX agent_reborn_intents_channel_due_idx ON data.agent_reborn_intents (channel_id, next_attempt_at)
  WHERE state IN ('waiting','prepared','failed');
CREATE INDEX machine_run_terminal_reports_channel_pending_idx
  ON data.machine_run_terminal_reports (channel_id, next_attempt_at) WHERE state = 'pending';
CREATE INDEX machine_run_terminal_reports_channel_finalized_idx
  ON data.machine_run_terminal_reports (channel_id, finalized_at) WHERE state = 'finalized';
CREATE INDEX registration_stop_intents_channel_pending_idx
  ON data.registration_stop_intents (channel_id, next_attempt_at) WHERE state = 'pending';
CREATE INDEX registration_launch_intents_channel_open_idx
  ON data.registration_launch_intents (channel_id, next_check_at) WHERE state IN ('preparing','aborted');
CREATE INDEX agent_routing_invocations_channel_starting_idx
  ON data.agent_routing_invocations (channel_id, updated_at) WHERE state = 'starting';
