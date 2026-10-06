-- Human-facing labels may repeat. Keep historical name/name_key addresses
-- intact so existing invocations and older clients retain their exact targets.
ALTER TABLE data.agent_profiles ADD COLUMN display_name TEXT;
CREATE INDEX agent_profiles_space_display_name_idx
  ON data.agent_profiles (space_id, lower(display_name));
