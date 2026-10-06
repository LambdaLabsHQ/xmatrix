-- The last Agent Profile names. Apply once every serving Hub reads and writes
-- agent_creation_policy and agentInstanceId (the release after
-- 0105_contract_registration_only); none of them reads what this removes.

SET LOCAL lock_timeout = '5s';

DROP TRIGGER space_member_creation_policies_sync_agent_creation ON data.space_member_creation_policies;
DROP FUNCTION data.space_member_creation_policies_sync_agent_creation();
ALTER TABLE data.space_member_creation_policies DROP COLUMN agent_profile_creation_policy;

UPDATE data.management_actions
  SET evidence_json = evidence_json #- '{automationApproval,agentProfileId}'
  WHERE evidence_json #> '{automationApproval,agentProfileId}' IS NOT NULL;
