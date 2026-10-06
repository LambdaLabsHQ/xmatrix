-- Grant expansion does not interrupt accepted work. Revocation, re-enablement
-- and resource narrowing advance an independent, non-resurrecting fence.
ALTER TABLE data.space_agent_registration_access ADD COLUMN grant_execution_revision BIGINT;
ALTER TABLE data.space_agent_registration_access ADD CONSTRAINT registration_grant_execution_revision_valid
  CHECK (grant_execution_revision >= 1 AND grant_execution_revision <= grant_revision) NOT VALID;
