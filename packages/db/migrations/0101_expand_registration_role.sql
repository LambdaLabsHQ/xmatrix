-- A Space registration may run as one published Role Package version. The Hub
-- resolves that version from the Role store when an admin assigns it and keeps
-- the snapshot the launch needs here, beside the registration it configures,
-- so a launch on any shard never reads the Role store.
ALTER TABLE data.space_agent_registrations
  ADD COLUMN role_json JSONB CHECK (role_json IS NULL OR
    (jsonb_typeof(role_json) = 'object' AND pg_column_size(role_json) <= 262144));
