-- Each Channel's coordinator reads its own Automation wakes, and the release
-- cutover pages Channels that have Automation work; both select Automations
-- by Channel. Without this index each read scans every Automation.
CREATE INDEX automations_channel_idx
  ON data.automations (channel_id, enabled, next_run_at);
