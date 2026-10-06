-- Agent direct messages are retired: a direct conversation is between two
-- Humans, and an Agent is reached by @-ing it in a conversation. Apply once
-- every serving Hub refuses to create an Agent DM and no longer wakes one
-- (the release that shipped "Agent direct messages retire").
--
-- Removes every direct conversation with an Agent participant, and every
-- fact keyed by it, in the Space purge's order. It refuses to run while any of
-- them still has a live Instance: that is someone's working session, and
-- deleting its rows under it would strand the process. Stop those Instances,
-- then apply.
--
-- Not removed, as in a Space purge: content-addressed `objects/<sha256>` bytes
-- (they may be shared), restricted summon-decision payloads (the decision
-- collector expires them by Space), and short-lived Space-keyed queues.
-- data.retired_agent_dm_purges keeps what was removed.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS data.retired_agent_dm_purges (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  participant_key TEXT NOT NULL,
  message_count BIGINT NOT NULL CHECK (message_count >= 0),
  purged_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, channel_id)
);

CREATE TEMP TABLE retired_agent_dm ON COMMIT DROP AS
  SELECT c.space_id, c.channel_id, c.metadata_json->>'participantKey' AS participant_key
  FROM data.channels c
  WHERE c.metadata_json->>'kind' = 'direct'
    AND jsonb_typeof(c.metadata_json->'participants') = 'array'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.metadata_json->'participants') p
      WHERE p->>'kind' = 'agent');

DO $$
DECLARE live BIGINT;
BEGIN
  SELECT count(*) INTO live FROM data.instances
    WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm) AND status IN ('online', 'busy', 'idle');
  IF live > 0 THEN
    RAISE EXCEPTION 'retired Agent DMs still have % live Instance(s); stop them first', live;
  END IF;
END $$;

CREATE TEMP TABLE retired_agent_dm_run ON COMMIT DROP AS
  SELECT run_id FROM data.runs WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
CREATE TEMP TABLE retired_agent_dm_instance ON COMMIT DROP AS
  SELECT instance_id FROM data.instances WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
CREATE TEMP TABLE retired_agent_dm_scope ON COMMIT DROP AS
  SELECT 'channel:' || channel_id AS scope_id FROM retired_agent_dm;

INSERT INTO data.retired_agent_dm_purges (space_id, channel_id, participant_key, message_count, purged_at)
  SELECT d.space_id, d.channel_id, COALESCE(d.participant_key, ''),
    (SELECT count(*) FROM data.messages m WHERE m.space_id = d.space_id AND m.channel_id = d.channel_id),
    clock_timestamp()
  FROM retired_agent_dm d
  ON CONFLICT (space_id, channel_id) DO NOTHING;

DELETE FROM data.automation_occurrences WHERE automation_id IN (
  SELECT automation_id FROM data.automations WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm));
DELETE FROM data.automations WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);

-- Run- and Instance-keyed facts that do not carry the Channel.
DELETE FROM data.run_agent_registrations WHERE run_id IN (SELECT run_id FROM retired_agent_dm_run);
DELETE FROM control.registration_execution_allocations WHERE run_id IN (SELECT run_id FROM retired_agent_dm_run);
DELETE FROM control.registration_preparation_cancellations WHERE run_id IN (SELECT run_id FROM retired_agent_dm_run);
DELETE FROM control.entity_space_routes
  WHERE (entity_kind = 'channel' AND entity_id IN (SELECT channel_id FROM retired_agent_dm))
    OR (entity_kind = 'instance' AND entity_id IN (SELECT instance_id FROM retired_agent_dm_instance));
DELETE FROM data.cross_space_read_grants
  WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm)
    OR source_channel_id IN (SELECT channel_id FROM retired_agent_dm)
    OR run_id IN (SELECT run_id FROM retired_agent_dm_run);

DELETE FROM data.instances WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.runs WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.natural_key_counters WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.natural_key_reservations WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.machine_run_routes WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.machine_run_snapshot_heads WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.machine_run_terminal_reports WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.machine_secret_requests WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.secret_grants WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.secret_instance_approvals WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.trace_access_grants WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);

-- Scope-keyed facts.
DELETE FROM data.extension_index_entries WHERE scope_kind = 'channel'
  AND scope_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.extension_index_heads WHERE scope_kind = 'channel'
  AND scope_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.extension_records WHERE scope_kind = 'channel'
  AND scope_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM control.scoped_control_command_replays WHERE scope_kind = 'channel'
  AND scope_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.projection_manifest_grants WHERE visibility_scope_id IN (SELECT scope_id FROM retired_agent_dm_scope);
DELETE FROM data.projection_scope_heads WHERE visibility_scope_id IN (SELECT scope_id FROM retired_agent_dm_scope);
DELETE FROM data.control_intents WHERE scope_id IN (SELECT scope_id FROM retired_agent_dm_scope);
DELETE FROM data.content_refs WHERE root_set_id IN (SELECT scope_id FROM retired_agent_dm_scope);
DELETE FROM data.content_closure_heads WHERE root_set_id IN (SELECT scope_id FROM retired_agent_dm_scope);
DELETE FROM data.blob_upload_intents WHERE scope_id IN (SELECT scope_id FROM retired_agent_dm_scope);
DELETE FROM data.page_links WHERE conversation_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.page_claims WHERE conversation_id IN (SELECT channel_id FROM retired_agent_dm);

-- Channel-keyed facts, then the Channel and the routes that locate it.
DELETE FROM data.agent_launches WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.agent_message_executions WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.agent_reborn_intents WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.app_connector_channel_bindings WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.app_connector_executions WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.app_source_relations WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.channel_access WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.channel_content_counters WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.channel_message_sequences WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.channel_transfer_proposals WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.cross_space_read_notices WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.delivery_cursors WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.message_annotations WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.message_attachment_refs WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.message_attachments WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.message_attention WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.message_attention_revisions WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.message_mutations WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.message_reactions WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.message_sequence_reservations WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.messages WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.registration_launch_intents WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.registration_stop_intents WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM control.channel_space_directory WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM control.channel_space_routes WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
DELETE FROM data.channels WHERE channel_id IN (SELECT channel_id FROM retired_agent_dm);
