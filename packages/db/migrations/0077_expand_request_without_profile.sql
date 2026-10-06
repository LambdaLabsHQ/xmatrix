-- In a Space whose Agents are composite registrations, a creation request
-- reserves no Profile identity: confirming it offers a registration instead.
-- Legacy Spaces still reserve one, so this only relaxes the constraint.
ALTER TABLE data.agent_profile_creation_requests ALTER COLUMN profile_id DROP NOT NULL;
