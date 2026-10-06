-- Step 4 of making stored Instance and Run ids their natural keys
-- (docs/architecture/instance-run-natural-keys.md).
--
-- The owner decided on 2026-09-25 to discard every existing Run and Instance,
-- live ones included, instead of migrating them: before this migration their
-- ids were minted uuids or creation keys. Every creation path now reserves
-- its natural key first (0083 and the code that shipped with it), so after
-- this migration each stored id is exactly its key, and CHECK constraints
-- keep it that way:
--   Instance   <channel_id>:<channel_instance_id>
--   Run        <channel_id>:<channel_instance_id>#<k>  or  <channel_id>:about#<k>
--
-- Stop every Run before applying. A process still running afterwards loses
-- its Run and can no longer authenticate. Natural-key counters are kept, so an
-- ordinal issued before this migration is never reissued and old `@claude:3`
-- mentions in Channel history never name a new Instance. Messages, Channels,
-- Agent registrations and Automations themselves are kept.

SET LOCAL lock_timeout = '5s';

-- Rows that exist only for a Run or an Instance.
DELETE FROM data.run_agent_registrations;
DELETE FROM data.registration_stop_intents;
DELETE FROM data.registration_launch_intents;
DELETE FROM control.registration_execution_allocations;
DELETE FROM control.registration_preparation_cancellations;
DELETE FROM data.agent_reborn_intents;
DELETE FROM data.agent_message_executions;
DELETE FROM data.agent_launches;
DELETE FROM data.agent_routing_attempts;
UPDATE data.agent_routing_invocations SET accepted_instance_id = NULL WHERE accepted_instance_id IS NOT NULL;
DELETE FROM data.automation_occurrences;
UPDATE data.automations SET last_run_id = NULL WHERE last_run_id IS NOT NULL;
DELETE FROM data.machine_run_routes;
DELETE FROM data.secret_grants WHERE run_id IS NOT NULL OR instance_id IS NOT NULL;
DELETE FROM data.secret_instance_approvals;
DELETE FROM data.trace_access_grants WHERE instance_id IS NOT NULL;
DELETE FROM data.natural_key_reservations;
DELETE FROM control.entity_space_routes WHERE entity_kind IN ('run', 'instance');
DELETE FROM data.instances;
DELETE FROM data.runs;

ALTER TABLE data.instances ADD CONSTRAINT instances_natural_id_check
  CHECK (instance_id = channel_id || ':' || channel_instance_id::text);
ALTER TABLE data.instances ADD CONSTRAINT instances_natural_run_check
  CHECK (left(run_id, length(instance_id) + 1) = instance_id || '#'
    AND substr(run_id, length(instance_id) + 2) ~ '^[1-9][0-9]{0,15}$');
ALTER TABLE data.runs ADD CONSTRAINT runs_natural_id_check
  CHECK (left(run_id, length(channel_id) + 1) = channel_id || ':'
    AND substr(run_id, length(channel_id) + 2) ~ '^([1-9][0-9]{0,15}|about)#[1-9][0-9]{0,15}$');
