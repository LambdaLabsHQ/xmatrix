-- Execution identity and admitted scope, independent of legacy Profile IDs.
-- The existing Run remains the only lifecycle authority. Physical allocations
-- are global and therefore cannot have a cross-shard SQL foreign key here.
CREATE TABLE data.run_agent_registrations (
  run_id TEXT PRIMARY KEY REFERENCES data.runs(run_id),
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 300),
  allocation_id TEXT NOT NULL UNIQUE CHECK (length(allocation_id) BETWEEN 1 AND 300),
  authorization_digest TEXT NOT NULL CHECK (authorization_digest ~ '^[a-f0-9]{64}$'),
  grant_revision BIGINT NOT NULL CHECK (grant_revision >= 1),
  grant_execution_revision BIGINT NOT NULL CHECK (grant_execution_revision BETWEEN 1 AND grant_revision),
  policy_revision BIGINT NOT NULL CHECK (policy_revision >= 1),
  policy_execution_revision BIGINT NOT NULL CHECK (policy_execution_revision BETWEEN 1 AND policy_revision),
  requested_json JSONB NOT NULL CHECK (jsonb_typeof(requested_json)='object' AND pg_column_size(requested_json)<=131072),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (space_id,owner_user_id,machine_id,harness)
    REFERENCES data.space_agent_registrations(space_id,owner_user_id,machine_id,harness)
);
CREATE INDEX run_agent_registrations_scope_idx
  ON data.run_agent_registrations(space_id,owner_user_id,machine_id,harness,run_id);
