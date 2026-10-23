-- A message occurrence does not reserve a Run: each authorized invocation in
-- its canonical message gets its own registration launch and may fail before
-- creating a Run. The existing launch intent is the sole source-to-Run fact.
ALTER TABLE data.automation_occurrences ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE data.automation_occurrences ALTER COLUMN instance_id DROP NOT NULL;

-- This is the byte contract of deterministicConversationId("automation-occurrence", id),
-- including its fixed version/variant nibbles. It recovers only the conversation
-- the scheduler actually addresses, never a name, timestamp, or metadata claim.
CREATE FUNCTION data.automation_occurrence_conversation_id(occurrence_id text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12)
  FROM (SELECT encode(sha256(convert_to('automation-occurrence'||chr(10)||occurrence_id,'UTF8')),'hex') AS h) digest
$$;

-- A read projection, not another execution ledger. Multiple invocations in
-- one message remain multiple Runs. Reservations/preparations without a Run
-- cannot appear here. Historical evidence is read in place; nothing is guessed
-- or rewritten when the original launch or Run no longer exists.
CREATE VIEW data.automation_occurrence_runs AS
SELECT o.occurrence_id,o.automation_id,root.space_id,p.channel_id,p.source_message_id,
  p.selection_index,p.launch_id,p.instance_id,r.run_id,r.owner_user_id,r.status,r.created_at,r.finished_at
FROM data.automation_occurrences o
JOIN data.automations a ON a.automation_id=o.automation_id
JOIN data.channels root ON root.channel_id=a.channel_id
JOIN data.registration_launch_intents p
  ON p.channel_id=data.automation_occurrence_conversation_id(o.occurrence_id)
  AND p.source_message_id=o.message_id AND p.space_id=root.space_id AND p.state='committed'
JOIN data.channels destination ON destination.channel_id=p.channel_id AND destination.space_id=root.space_id
JOIN data.runs r ON r.run_id=p.run_id AND r.channel_id=p.channel_id AND r.owner_user_id=p.owner_user_id
JOIN data.run_agent_registrations binding ON binding.run_id=r.run_id AND binding.space_id=p.space_id
  AND binding.owner_user_id=p.owner_user_id AND binding.machine_id=p.machine_id AND binding.harness=p.harness
WHERE o.delivery_kind='message'
UNION ALL
SELECT o.occurrence_id,o.automation_id,c.space_id,r.channel_id,NULL::text,
  NULL::integer,NULL::text,o.instance_id,r.run_id,r.owner_user_id,r.status,r.created_at,r.finished_at
FROM data.automation_occurrences o
JOIN data.automations a ON a.automation_id=o.automation_id
JOIN data.channels c ON c.channel_id=a.channel_id
JOIN data.runs r ON r.run_id=o.run_id AND r.channel_id=a.channel_id AND r.owner_user_id=o.owner_user_id
WHERE o.delivery_kind='agent_run';
