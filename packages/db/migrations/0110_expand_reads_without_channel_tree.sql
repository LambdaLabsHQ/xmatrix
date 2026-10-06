-- Nothing reads the Channel tree, archive state or tree views any more
-- (docs/design/pages-and-conversations-migration.md §2.1); the contract
-- migration drops them.

-- The table stays for pins and the follow-up review schedule; only tree views go.
ALTER TABLE data.user_space_channel_view_preferences ALTER COLUMN child_views_json DROP NOT NULL;

-- A thread names its root Channel and message in its own metadata, which is how
-- a history page finds the threads opened on it once parent_channel_id is gone.
CREATE INDEX channels_thread_root_idx
  ON data.channels (space_id, (metadata_json->>'threadRootChannelId'), (metadata_json->>'threadRootMessageId'))
  WHERE metadata_json->>'kind' = 'thread';
