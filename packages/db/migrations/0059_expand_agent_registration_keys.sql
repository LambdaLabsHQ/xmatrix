-- Preparation only: no inferred backfill and no switch of active authority.
-- A bounded cutover must reconcile legacy profiles before enabling these facts.
CREATE TABLE data.agent_registrations (
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_user_id, machine_id, harness),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(machine_id) BETWEEN 1 AND 300),
  CHECK (harness ~ '^[a-z][a-z0-9-]{0,79}$' AND harness <> 'custom'),
  CHECK (updated_at >= created_at)
);

-- A registration's identity is independent of its Space memberships.
CREATE TABLE data.space_agent_registrations (
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  display_name TEXT NOT NULL,
  configuration_json JSONB NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, owner_user_id, machine_id, harness),
  FOREIGN KEY (owner_user_id, machine_id, harness)
    REFERENCES data.agent_registrations (owner_user_id, machine_id, harness),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(display_name) BETWEEN 1 AND 80),
  CHECK (jsonb_typeof(configuration_json) = 'object'),
  CHECK (updated_at >= created_at)
);

-- Bounded compatibility for pre-cutover references. This table contains no
-- configuration or permissions and cannot become a second registration writer.
CREATE TABLE control.legacy_agent_registration_references (
  legacy_profile_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  migrated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (space_id, owner_user_id, machine_id, harness)
    REFERENCES data.space_agent_registrations (space_id, owner_user_id, machine_id, harness),
  CHECK (length(legacy_profile_id) BETWEEN 1 AND 300)
);
