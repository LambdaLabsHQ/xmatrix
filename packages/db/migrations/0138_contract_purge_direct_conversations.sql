-- Direct messages are retired: people and Agents are reached in a
-- conversation. Apply once every serving Hub refuses to create a direct
-- conversation (the release that shipped "direct messages are retired").
--
-- Removes every direct conversation and every fact keyed by it, in the Space
-- purge's order. They are removed rather than turned into
-- ordinary closed Channels: a direct conversation is readable by its two
-- participants only, while an ordinary closed Channel is also readable by the
-- Space's owners and admins, so keeping the history would widen who can read
-- it. It refuses to run while any of them still has a live Instance: that is
-- someone's working session. Stop those Instances, then apply.
--
-- Not removed, as in a Space purge: content-addressed `objects/<sha256>` bytes
-- (they may be shared), restricted summon-decision payloads (the decision
-- collector expires them by Space), and short-lived Space-keyed queues.
-- data.retired_direct_conversation_purges keeps what was removed. The index
-- that kept one active conversation per participant pair goes with them.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS data.retired_direct_conversation_purges (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  participant_key TEXT NOT NULL,
  message_count BIGINT NOT NULL CHECK (message_count >= 0),
  purged_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, channel_id)
);

CREATE TEMP TABLE retired_direct ON COMMIT DROP AS
  SELECT c.space_id, c.channel_id, c.metadata_json->>'participantKey' AS participant_key
  FROM data.channels c
  WHERE c.metadata_json->>'kind' = 'direct';

DO $$
DECLARE live BIGINT;
BEGIN
  SELECT count(*) INTO live FROM data.instances
    WHERE channel_id IN (SELECT channel_id FROM retired_direct) AND status IN ('online', 'busy', 'idle');
  IF live > 0 THEN
    RAISE EXCEPTION 'direct conversations still have % live Instance(s); stop them first', live;
  END IF;
END $$;

CREATE TEMP TABLE retired_direct_run ON COMMIT DROP AS
  SELECT run_id FROM data.runs WHERE channel_id IN (SELECT channel_id FROM retired_direct);
CREATE TEMP TABLE retired_direct_instance ON COMMIT DROP AS
  SELECT instance_id FROM data.instances WHERE channel_id IN (SELECT channel_id FROM retired_direct);
CREATE TEMP TABLE retired_direct_scope ON COMMIT DROP AS
  SELECT 'channel:' || channel_id AS scope_id FROM retired_direct;

INSERT INTO data.retired_direct_conversation_purges (space_id, channel_id, participant_key, message_count, purged_at)
  SELECT d.space_id, d.channel_id, COALESCE(d.participant_key, ''),
    (SELECT count(*) FROM data.messages m WHERE m.space_id = d.space_id AND m.channel_id = d.channel_id),
    clock_timestamp()
  FROM retired_direct d
  ON CONFLICT (space_id, channel_id) DO NOTHING;

DELETE FROM data.automation_occurrences WHERE automation_id IN (
  SELECT automation_id FROM data.automations WHERE channel_id IN (SELECT channel_id FROM retired_direct));
DELETE FROM data.automations WHERE channel_id IN (SELECT channel_id FROM retired_direct);

-- Run- and Instance-keyed facts that do not carry the Channel.
DELETE FROM data.run_agent_registrations WHERE run_id IN (SELECT run_id FROM retired_direct_run);
DELETE FROM data.run_secret_approvals WHERE run_id IN (SELECT run_id FROM retired_direct_run);
DELETE FROM control.registration_execution_allocations WHERE run_id IN (SELECT run_id FROM retired_direct_run);
DELETE FROM control.registration_preparation_cancellations WHERE run_id IN (SELECT run_id FROM retired_direct_run);
DELETE FROM control.entity_space_routes
  WHERE (entity_kind = 'channel' AND entity_id IN (SELECT channel_id FROM retired_direct))
    OR (entity_kind = 'instance' AND entity_id IN (SELECT instance_id FROM retired_direct_instance));
DELETE FROM data.cross_space_read_grants
  WHERE channel_id IN (SELECT channel_id FROM retired_direct)
    OR source_channel_id IN (SELECT channel_id FROM retired_direct)
    OR run_id IN (SELECT run_id FROM retired_direct_run);

DELETE FROM data.instances WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.runs WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.natural_key_counters WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.natural_key_reservations WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.machine_run_routes WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.machine_run_snapshot_heads WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.machine_run_terminal_reports WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.trace_access_grants WHERE channel_id IN (SELECT channel_id FROM retired_direct);

-- Scope-keyed facts.
DELETE FROM data.extension_index_entries WHERE scope_kind = 'channel'
  AND scope_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.extension_index_heads WHERE scope_kind = 'channel'
  AND scope_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.extension_records WHERE scope_kind = 'channel'
  AND scope_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM control.scoped_control_command_replays WHERE scope_kind = 'channel'
  AND scope_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.projection_manifest_grants WHERE visibility_scope_id IN (SELECT scope_id FROM retired_direct_scope);
DELETE FROM data.projection_scope_heads WHERE visibility_scope_id IN (SELECT scope_id FROM retired_direct_scope);
DELETE FROM data.control_intents WHERE scope_id IN (SELECT scope_id FROM retired_direct_scope);
DELETE FROM data.content_refs WHERE root_set_id IN (SELECT scope_id FROM retired_direct_scope);
DELETE FROM data.content_closure_heads WHERE root_set_id IN (SELECT scope_id FROM retired_direct_scope);
DELETE FROM data.blob_upload_intents WHERE scope_id IN (SELECT scope_id FROM retired_direct_scope);
DELETE FROM data.page_links WHERE conversation_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.page_claims WHERE conversation_id IN (SELECT channel_id FROM retired_direct);

-- Channel-keyed facts, then the Channel and the routes that locate it.
DELETE FROM data.agent_launches WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.agent_message_executions WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.agent_reborn_intents WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.app_connector_action_policies WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.app_connector_channel_bindings WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.app_connector_executions WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.app_source_relations WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.channel_access WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.channel_content_counters WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.channel_message_sequences WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.channel_transfer_proposals WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.cross_space_read_notices WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.delivery_cursors WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.first_message_launch_choices WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.message_annotations WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.message_attachment_refs WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.message_attachments WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.message_attention WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.message_attention_revisions WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.message_mutations WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.message_reactions WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.message_sequence_reservations WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.messages WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.registration_launch_intents WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.registration_stop_intents WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM control.channel_space_directory WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM control.channel_space_routes WHERE channel_id IN (SELECT channel_id FROM retired_direct);
DELETE FROM data.channels WHERE channel_id IN (SELECT channel_id FROM retired_direct);

DROP INDEX IF EXISTS data.channels_active_direct_participant_key_idx;
