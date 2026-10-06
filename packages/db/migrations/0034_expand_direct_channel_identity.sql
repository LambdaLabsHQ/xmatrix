CREATE UNIQUE INDEX channels_active_direct_participant_key_idx
  ON data.channels (space_id, (metadata_json->>'participantKey'))
  WHERE archived_at IS NULL
    AND metadata_json->>'kind' = 'direct'
    AND metadata_json->>'participantKey' IS NOT NULL;

CREATE UNIQUE INDEX channels_active_thread_root_idx
  ON data.channels (space_id, parent_channel_id, (metadata_json->>'threadRootMessageId'))
  WHERE archived_at IS NULL
    AND metadata_json->>'kind' = 'thread'
    AND metadata_json->>'threadRootMessageId' IS NOT NULL;
