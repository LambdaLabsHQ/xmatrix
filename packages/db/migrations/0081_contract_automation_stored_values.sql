-- M2 of the Automation storage rename: stored values stop saying "task".
--
-- Deployed Hub code (C1, #2816) writes every value below in the automation
-- spelling and reads both spellings, so rewriting a row changes nothing it
-- observes. This migration rewrites the remaining pre-rename rows and drops
-- the two compatibility views M1 (0080) created; after it, the Hub (C2) reads
-- only the automation spelling. Inventory and predicates:
-- docs/operations/automation-stored-values-inventory.md.
--
-- The migrator runs this file inside one transaction. Every predicate selects
-- only pre-rename rows, so a re-run (or a run on a shard that never had any)
-- updates nothing.

-- Fail fast instead of queueing Automation traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

-- Bound the one-transaction rewrite. Expected counts are small (tens to a few
-- thousand rows per shard: pause approvals, audit rows, live directory routes,
-- replay rows younger than 30 days, Automation Runs). A shard far above that
-- would hold row locks for too long in one transaction; refuse it so the
-- operator can rewrite that table in batches with the same predicates first.
DO $bound$
DECLARE
  legacy_rows bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM data.management_actions
      WHERE action_type IN ('scheduled_task_update', 'scheduled_task_pause',
                            'scheduled_task_resume', 'scheduled_task_delete')
         OR evidence_json->'automationApproval' ?| ARRAY['taskId', 'taskVersion']
         OR evidence_json->'automationGovernance' ? 'taskId')
    + (SELECT count(*) FROM control.entity_space_routes WHERE entity_kind = 'scheduled-task')
    + (SELECT count(*) FROM data.outbox
        WHERE topic = 'space-control' AND aggregate_kind = 'scheduled-task')
    + (SELECT count(*) FROM control.scoped_control_command_replays
        WHERE scope_kind = 'space' AND command_kind IN ('scheduled_task_put', 'scheduled_task_remove'))
    + (SELECT count(*) FROM data.runs
        WHERE metadata_json ?| ARRAY['scheduledTaskId', 'scheduledTaskName', 'scheduledOccurrenceId']
           OR metadata_json->>'routedAs' = 'scheduled_task')
    + (SELECT count(*) FROM data.automation_occurrences WHERE error_code = 'task_paused')
    + (SELECT count(*) FROM data.automations
        WHERE payload_json->>'payloadVersion' = '3'
          AND (payload_json#>>'{input,datum,ref}' LIKE 'scheduled-task:%'
            OR payload_json#>>'{input,lineage,rootMessageId}' LIKE 'scheduled-task:%'))
  INTO legacy_rows;
  IF legacy_rows > 200000 THEN
    RAISE EXCEPTION 'Automation stored-value rewrite would touch % rows in one transaction; batch it first',
      legacy_rows;
  END IF;
END
$bound$;

-- management_actions.action_type
UPDATE data.management_actions
SET action_type = 'automation_' || substr(action_type, length('scheduled_task_') + 1)
WHERE action_type IN ('scheduled_task_update', 'scheduled_task_pause',
                      'scheduled_task_resume', 'scheduled_task_delete');

-- management_actions.evidence_json: pause-approval and audit keys
UPDATE data.management_actions
SET evidence_json = jsonb_set(evidence_json, '{automationApproval}',
  ((evidence_json->'automationApproval') - 'taskId' - 'taskVersion') || jsonb_strip_nulls(jsonb_build_object(
    'automationId', evidence_json#>'{automationApproval,taskId}',
    'automationVersion', evidence_json#>'{automationApproval,taskVersion}')))
WHERE evidence_json->'automationApproval' ?| ARRAY['taskId', 'taskVersion'];

UPDATE data.management_actions
SET evidence_json = jsonb_set(evidence_json, '{automationGovernance}',
  ((evidence_json->'automationGovernance') - 'taskId')
    || jsonb_build_object('automationId', evidence_json#>'{automationGovernance,taskId}'))
WHERE evidence_json->'automationGovernance' ? 'taskId';

-- entity_space_routes.entity_kind. (entity_kind, entity_id) is the primary key:
-- where both spellings exist, the automation row was published later and
-- wins, so the legacy duplicate is deleted before the rest are renamed.
DELETE FROM control.entity_space_routes legacy
WHERE legacy.entity_kind = 'scheduled-task' AND EXISTS (
  SELECT 1 FROM control.entity_space_routes current
  WHERE current.entity_kind = 'automation' AND current.entity_id = legacy.entity_id);
UPDATE control.entity_space_routes SET entity_kind = 'automation'
WHERE entity_kind = 'scheduled-task';

-- outbox aggregate_kind and the command kind inside its payload. Every row is
-- rewritten, delivered or not: outbox_id (space + commit sequence) is the
-- primary key, so no two rows can meet on the unique aggregate key.
UPDATE data.outbox
SET aggregate_kind = 'automation',
    payload_json = CASE payload_json->>'kind'
      WHEN 'scheduled_task_put' THEN jsonb_set(payload_json, '{kind}', '"automation_put"')
      WHEN 'scheduled_task_remove' THEN jsonb_set(payload_json, '{kind}', '"automation_remove"')
      ELSE payload_json END
WHERE topic = 'space-control' AND aggregate_kind = 'scheduled-task';

-- replay ledger command_kind and the kind in its stored result
UPDATE control.scoped_control_command_replays
SET command_kind = CASE command_kind WHEN 'scheduled_task_put' THEN 'automation_put'
                                     ELSE 'automation_remove' END,
    result_json = CASE WHEN jsonb_typeof(result_json) = 'object' AND result_json ? 'kind'
      THEN jsonb_set(result_json, '{kind}', to_jsonb(CASE command_kind
        WHEN 'scheduled_task_put' THEN 'automation_put' ELSE 'automation_remove' END))
      ELSE result_json END
WHERE scope_kind = 'space' AND command_kind IN ('scheduled_task_put', 'scheduled_task_remove');

-- Automation Run metadata keys and routedAs
UPDATE data.runs
SET metadata_json = (metadata_json - 'scheduledTaskId' - 'scheduledTaskName' - 'scheduledOccurrenceId')
  || jsonb_strip_nulls(jsonb_build_object(
       'automationId', metadata_json->'scheduledTaskId',
       'automationName', metadata_json->'scheduledTaskName',
       'automationOccurrenceId', metadata_json->'scheduledOccurrenceId'))
  || CASE WHEN metadata_json->>'routedAs' = 'scheduled_task'
       THEN '{"routedAs":"automation"}'::jsonb ELSE '{}'::jsonb END
WHERE metadata_json ?| ARRAY['scheduledTaskId', 'scheduledTaskName', 'scheduledOccurrenceId']
   OR metadata_json->>'routedAs' = 'scheduled_task';

-- occurrence error code
UPDATE data.automation_occurrences SET error_code = 'automation_paused'
WHERE error_code = 'task_paused';

-- Evaluator refs and lineage roots: the prefix only; the Automation id after
-- it is opaque and stays byte-identical. Every row of one lineage is rewritten
-- together, so lineage equality is preserved.
UPDATE data.automations
SET payload_json = jsonb_set(payload_json, '{input,datum,ref}',
  to_jsonb('automation:' || substr(payload_json#>>'{input,datum,ref}', length('scheduled-task:') + 1)))
WHERE payload_json->>'payloadVersion' = '3'
  AND payload_json#>>'{input,datum,ref}' LIKE 'scheduled-task:%';

UPDATE data.automations
SET payload_json = jsonb_set(payload_json, '{input,lineage,rootMessageId}',
  to_jsonb('automation:' || substr(payload_json#>>'{input,lineage,rootMessageId}',
    length('scheduled-task:') + 1)))
WHERE payload_json->>'payloadVersion' = '3'
  AND payload_json#>>'{input,lineage,rootMessageId}' LIKE 'scheduled-task:%';

-- M1's compatibility views. No Hub deployed since 0.16.369 reads them.
DROP VIEW data.scheduled_task_occurrences;
DROP VIEW data.scheduled_tasks;
