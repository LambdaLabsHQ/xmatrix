-- GitHub's per-action write channels move onto the generic Channel action
-- policy (docs/design/connector-platform.md §3.5). Each `*WriteChannelId` a
-- GitHub connection's metadata names becomes an `allow` row for the actions
-- it enabled, in a Channel of the same Space. Existing rows win; replaying the
-- migration inserts nothing new. The metadata keys stay readable and are no
-- longer consulted.

SET LOCAL lock_timeout = '5s';

INSERT INTO data.app_connector_action_policies
  (connection_id, channel_id, action_id, space_id, mode, version, updated_by, created_at, updated_at)
SELECT c.connection_id, ch.channel_id, mapped.action_id, c.space_id, 'allow', 1, c.created_by, now(), now()
FROM data.app_connector_connections c
CROSS JOIN LATERAL (VALUES
  ('commentWriteChannelId', 'comment'),
  ('createIssueWriteChannelId', 'create_issue'),
  ('closeReopenWriteChannelId', 'close_issue'),
  ('closeReopenWriteChannelId', 'reopen_issue'),
  ('reviewWriteChannelId', 'review'),
  ('actionsWriteChannelId', 'rerun_failed_jobs'),
  ('actionsWriteChannelId', 'dispatch_workflow')
) AS mapped(metadata_key, action_id)
JOIN data.channels ch
  ON ch.channel_id = c.metadata_json ->> mapped.metadata_key AND ch.space_id = c.space_id
WHERE c.provider_id = 'github' AND c.metadata_json IS NOT NULL
ON CONFLICT (connection_id, channel_id, action_id) DO NOTHING;
