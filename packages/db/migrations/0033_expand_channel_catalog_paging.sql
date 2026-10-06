ALTER TABLE data.channels
  ADD COLUMN activity_at TIMESTAMPTZ;

CREATE INDEX channels_space_activity_idx
  ON data.channels (space_id, archived_at, activity_at DESC, channel_id);

CREATE INDEX channels_space_parent_activity_idx
  ON data.channels (space_id, parent_channel_id, archived_at, activity_at DESC, channel_id);

CREATE INDEX channels_space_direct_activity_idx
  ON data.channels (space_id, activity_at DESC, channel_id)
  WHERE metadata_json->>'kind' = 'direct' AND archived_at IS NULL;
