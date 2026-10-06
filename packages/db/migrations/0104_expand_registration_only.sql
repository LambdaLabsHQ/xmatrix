-- Every Run executes under a Space registration; there is no Agent Profile.
-- Hubs from this release no longer read or write the Profile columns or the
-- Profile routing tables; contract 0105_contract_registration_only drops them.

SET LOCAL lock_timeout = '5s';

-- An execution report names its Run's Instance; the Profile column is unwritten.
ALTER TABLE data.agent_message_executions ALTER COLUMN agent_profile_id DROP NOT NULL;
