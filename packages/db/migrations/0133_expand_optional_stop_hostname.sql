-- Stop authorization uses exact owner, Machine, Run and execution evidence.
-- A mutable hostname is optional and must never block permission revocation.
ALTER TABLE data.registration_stop_intents ALTER COLUMN host_id DROP NOT NULL;
