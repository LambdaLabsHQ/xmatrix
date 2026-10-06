-- Activation is a reviewed, bounded maintenance operation, never a client flag.
-- A Space remains on legacy authority until every reference and owner decision
-- in its immutable cutover manifest has been verified.
CREATE TABLE data.agent_registration_authority (
  space_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('prepared', 'composite')),
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
