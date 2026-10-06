-- Every Run executes under a Space registration; there is no Agent Profile.
--
-- Apply while the release that shipped 0104_expand_registration_only serves
-- traffic, then release the Hub that reads agent_creation_policy and
-- agentInstanceId. That serving Hub reads and writes none of what this drops,
-- still writes agent_profile_creation_policy (the trigger below carries it into
-- agent_creation_policy), and already records pause approvals under both keys.
-- Contract 0106 drops the trigger, the old column and the old key.

SET LOCAL lock_timeout = '5s';

-- Profile storage and the Profile routing ranking; nothing reads or writes them.
DROP TABLE data.agent_routing_attempts;
DROP TABLE data.agent_routing_invocations;
DROP TABLE data.agent_profile_creation_requests;
DROP TABLE data.agent_profiles;
DROP TABLE data.agent_registration_authority;
DROP TABLE control.legacy_agent_registration_references;

-- A Run, its Launch and its execution reports name the Run's Instance.
ALTER TABLE data.runs DROP COLUMN agent_profile_id;
ALTER TABLE data.agent_launches DROP COLUMN target_profile_id;
ALTER TABLE data.agent_message_executions DROP COLUMN agent_profile_id;

-- The Space's Agent creation policy governs registrations.
ALTER TABLE data.space_member_creation_policies
  ADD COLUMN agent_creation_policy TEXT CHECK (agent_creation_policy IN ('members', 'admins'));
UPDATE data.space_member_creation_policies SET agent_creation_policy = agent_profile_creation_policy;
ALTER TABLE data.space_member_creation_policies ALTER COLUMN agent_creation_policy SET NOT NULL;
ALTER TABLE data.space_member_creation_policies ALTER COLUMN agent_profile_creation_policy DROP NOT NULL;

-- Whichever column a serving Hub writes, the other follows until 0106.
CREATE FUNCTION data.space_member_creation_policies_sync_agent_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.agent_creation_policy := COALESCE(NEW.agent_creation_policy, NEW.agent_profile_creation_policy);
    NEW.agent_profile_creation_policy := COALESCE(NEW.agent_profile_creation_policy, NEW.agent_creation_policy);
  ELSIF NEW.agent_profile_creation_policy IS DISTINCT FROM OLD.agent_profile_creation_policy THEN
    NEW.agent_creation_policy := NEW.agent_profile_creation_policy;
  ELSIF NEW.agent_creation_policy IS DISTINCT FROM OLD.agent_creation_policy THEN
    NEW.agent_profile_creation_policy := NEW.agent_creation_policy;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER space_member_creation_policies_sync_agent_creation
  BEFORE INSERT OR UPDATE ON data.space_member_creation_policies
  FOR EACH ROW EXECUTE FUNCTION data.space_member_creation_policies_sync_agent_creation();

-- A pause approval names its requesting Agent by Instance.
UPDATE data.management_actions
  SET evidence_json = jsonb_set(evidence_json, '{automationApproval,agentInstanceId}',
    evidence_json #> '{automationApproval,agentProfileId}')
  WHERE evidence_json #> '{automationApproval,agentProfileId}' IS NOT NULL
    AND evidence_json #> '{automationApproval,agentInstanceId}' IS NULL;
