-- Separate pause-new-work revisions from revocation of admitted executions.
-- NULL is interpreted as the current policy revision for unconverted rows.
ALTER TABLE data.space_agent_registration_access ADD COLUMN policy_execution_revision BIGINT;
ALTER TABLE data.space_agent_registration_access ADD CONSTRAINT registration_execution_revision_valid
  CHECK (policy_execution_revision >= 1 AND policy_execution_revision <= policy_revision) NOT VALID;
