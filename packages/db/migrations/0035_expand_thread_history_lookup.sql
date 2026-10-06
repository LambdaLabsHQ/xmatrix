CREATE INDEX channels_thread_history_lookup_idx
  ON data.channels (
    space_id,
    parent_channel_id,
    (metadata_json->>'threadRootMessageId'),
    archived_at,
    updated_at DESC,
    channel_id
  )
  WHERE metadata_json->>'kind' = 'thread'
    AND metadata_json->>'threadRootMessageId' IS NOT NULL;
