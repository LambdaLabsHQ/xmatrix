-- A registered Run and its Launch belong to a composite registration and have
-- no legacy Agent Profile. Legacy writers still supply a Profile id; only the
-- constraint is relaxed, so this is expand-compatible with the running code.
ALTER TABLE data.runs ALTER COLUMN agent_profile_id DROP NOT NULL;
ALTER TABLE data.agent_launches ALTER COLUMN target_profile_id DROP NOT NULL;
