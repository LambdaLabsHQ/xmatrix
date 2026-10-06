-- A legacy minted Machine id (`machine:<uuid>`) is rewritten to the Machine's
-- host-derived id once, when its updated daemon first enrolls
-- (docs/architecture/machine-identity.md). The record makes a replay a no-op
-- and keeps the old spelling resolvable for audit.
CREATE TABLE control.machine_identity_adoptions (
  owner_user_id TEXT NOT NULL,
  legacy_machine_id TEXT NOT NULL CHECK (length(legacy_machine_id) BETWEEN 1 AND 300),
  machine_id TEXT NOT NULL CHECK (length(machine_id) BETWEEN 1 AND 300 AND machine_id <> legacy_machine_id),
  rewritten_json JSONB NOT NULL CHECK (jsonb_typeof(rewritten_json) = 'object'),
  adopted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id, legacy_machine_id)
);
