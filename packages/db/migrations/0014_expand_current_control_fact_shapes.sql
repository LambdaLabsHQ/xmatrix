ALTER TABLE data.agent_profiles
  ADD COLUMN name_key TEXT;

ALTER TABLE data.agent_profiles
  ADD COLUMN search_rank_sequence TEXT;

CREATE UNIQUE INDEX agent_profiles_space_name_key_idx
  ON data.agent_profiles (space_id, name_key) WHERE name_key IS NOT NULL;

CREATE UNIQUE INDEX agent_profiles_search_rank_idx
  ON data.agent_profiles (search_rank_sequence) WHERE search_rank_sequence IS NOT NULL;

CREATE UNIQUE INDEX workspaces_natural_identity_idx
  ON data.workspaces (machine_id, canonical_cwd) WHERE machine_id IS NOT NULL;

ALTER TABLE data.runs
  ADD COLUMN workspace_machine_id TEXT;

ALTER TABLE data.runs
  ADD COLUMN workspace_canonical_cwd TEXT;

ALTER TABLE data.runs
  ADD CONSTRAINT runs_workspace_natural_identity_pair
  CHECK ((workspace_machine_id IS NULL) = (workspace_canonical_cwd IS NULL)) NOT VALID;

CREATE INDEX runs_workspace_idx
  ON data.runs (workspace_machine_id, workspace_canonical_cwd, status, run_id)
  WHERE workspace_machine_id IS NOT NULL;

CREATE TABLE data.shared_memory_workspace_entries (
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  encoded_bytes BIGINT NOT NULL CHECK (encoded_bytes >= 0),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (owner_user_id, workspace_id, memory_key),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(workspace_id) BETWEEN 1 AND 1000),
  CHECK (length(memory_key) BETWEEN 1 AND 1000),
  CHECK (updated_at >= created_at)
);

CREATE INDEX shared_memory_workspace_entries_expiry_idx
  ON data.shared_memory_workspace_entries
    (expires_at, owner_user_id, workspace_id, memory_key)
  WHERE expires_at IS NOT NULL;
