-- Inactive until registration admission is wired to the owning runtime authority.
-- Explicit owner grants and Space policies have independent authorization revisions.
CREATE TABLE data.space_agent_registration_access (
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  grant_state TEXT NOT NULL CHECK (grant_state IN ('active', 'revoked')),
  grant_revision BIGINT NOT NULL CHECK (grant_revision >= 1),
  grant_limits JSONB NOT NULL CHECK (jsonb_typeof(grant_limits) = 'object'),
  policy_state TEXT NOT NULL CHECK (policy_state IN ('enabled', 'paused')),
  policy_revision BIGINT NOT NULL CHECK (policy_revision >= 1),
  policy_limits JSONB NOT NULL CHECK (jsonb_typeof(policy_limits) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, owner_user_id, machine_id, harness),
  FOREIGN KEY (space_id, owner_user_id, machine_id, harness)
    REFERENCES data.space_agent_registrations (space_id, owner_user_id, machine_id, harness)
);

-- A permission change cannot be acknowledged without durable reconciliation work.
-- Revision is scoped to the owner grant or Space policy; retries reuse this key.
CREATE TABLE data.registration_access_changes (
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  authority TEXT NOT NULL CHECK (authority IN ('owner', 'space')),
  revision BIGINT NOT NULL CHECK (revision >= 1),
  actor_user_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  reconcile_state TEXT NOT NULL CHECK (reconcile_state IN ('pending', 'completed')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, owner_user_id, machine_id, harness, authority, revision),
  UNIQUE (actor_user_id, command_id),
  FOREIGN KEY (space_id, owner_user_id, machine_id, harness)
    REFERENCES data.space_agent_registration_access (space_id, owner_user_id, machine_id, harness),
  CHECK (length(actor_user_id) BETWEEN 1 AND 300),
  CHECK (length(command_id) BETWEEN 1 AND 200),
  CHECK (request_digest ~ '^[a-f0-9]{64}$')
);
