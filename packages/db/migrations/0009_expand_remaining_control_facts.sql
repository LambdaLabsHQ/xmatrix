CREATE TABLE data.agent_profiles (
  agent_profile_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(agent_profile_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (metadata_json IS NULL OR jsonb_typeof(metadata_json) = 'object'),
  CHECK (updated_at >= created_at),
  UNIQUE (space_id, name)
);

CREATE TABLE data.roles (
  role_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  semantic_version TEXT NOT NULL,
  status TEXT NOT NULL,
  content_digest TEXT,
  search_rank_sequence TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(role_id) BETWEEN 1 AND 300),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(lineage_id) BETWEEN 1 AND 300),
  CHECK (metadata_json IS NULL OR jsonb_typeof(metadata_json) = 'object'),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX roles_search_rank_idx
  ON data.roles (search_rank_sequence) WHERE search_rank_sequence IS NOT NULL;

CREATE INDEX roles_owner_idx ON data.roles (owner_user_id, updated_at DESC, role_id);

CREATE TABLE data.workspaces (
  workspace_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT,
  canonical_cwd TEXT NOT NULL,
  search_rank_sequence TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(workspace_id) BETWEEN 1 AND 300),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(canonical_cwd) BETWEEN 1 AND 4000),
  CHECK (metadata_json IS NULL OR jsonb_typeof(metadata_json) = 'object'),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX workspaces_search_rank_idx
  ON data.workspaces (search_rank_sequence) WHERE search_rank_sequence IS NOT NULL;

CREATE INDEX workspaces_owner_idx ON data.workspaces (owner_user_id, updated_at DESC, workspace_id);

CREATE TABLE data.runs (
  run_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  workspace_id TEXT,
  status TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  CHECK (length(run_id) BETWEEN 1 AND 300),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(agent_profile_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (metadata_json IS NULL OR jsonb_typeof(metadata_json) = 'object'),
  CHECK (updated_at >= created_at)
);

CREATE INDEX runs_channel_status_idx ON data.runs (channel_id, status, updated_at, run_id);
CREATE INDEX runs_owner_idx ON data.runs (owner_user_id, updated_at DESC, run_id);

CREATE TABLE data.instances (
  instance_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  channel_instance_id BIGINT NOT NULL CHECK (channel_instance_id >= 1),
  status TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(instance_id) BETWEEN 1 AND 300),
  CHECK (length(run_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at),
  UNIQUE (channel_id, channel_instance_id)
);

CREATE TABLE data.scheduled_tasks (
  task_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  next_run_at TIMESTAMPTZ NOT NULL,
  enabled BOOLEAN NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  run_count BIGINT NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  last_run_at TIMESTAMPTZ,
  last_run_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(task_id) BETWEEN 1 AND 300),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (pg_column_size(payload_json) <= 262144),
  CHECK (updated_at >= created_at)
);

CREATE INDEX scheduled_tasks_due_idx
  ON data.scheduled_tasks (enabled, next_run_at, task_id);

CREATE TABLE data.scheduled_task_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_version BIGINT NOT NULL CHECK (task_version >= 1),
  owner_user_id TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'prepared', 'dispatched', 'failed', 'cancelled'
  )),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  instance_id TEXT NOT NULL UNIQUE,
  control_id TEXT NOT NULL UNIQUE,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  CHECK (length(occurrence_id) BETWEEN 1 AND 300),
  CHECK ((status IN ('leased', 'prepared') AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    OR (status NOT IN ('leased', 'prepared') AND lease_owner IS NULL AND lease_until IS NULL)),
  CHECK (updated_at >= created_at),
  UNIQUE (task_id, scheduled_for)
);

CREATE INDEX scheduled_task_occurrences_due_idx
  ON data.scheduled_task_occurrences (status, next_attempt_at, occurrence_id);

CREATE INDEX scheduled_task_occurrences_task_idx
  ON data.scheduled_task_occurrences (task_id, status, scheduled_for);

CREATE TABLE data.app_connector_connections (
  connection_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('configured', 'disconnected', 'error')),
  auth_mode TEXT NOT NULL CHECK (auth_mode IN ('oauth', 'api-token')),
  scopes_json JSONB NOT NULL CHECK (jsonb_typeof(scopes_json) = 'array'),
  secret_refs_json JSONB NOT NULL CHECK (jsonb_typeof(secret_refs_json) = 'array'),
  capabilities_json JSONB NOT NULL CHECK (jsonb_typeof(capabilities_json) IN ('array', 'object')),
  channel_ids_json JSONB NOT NULL CHECK (jsonb_typeof(channel_ids_json) = 'array'),
  agent_id TEXT,
  created_by TEXT NOT NULL,
  metadata_json JSONB,
  search_rank_sequence TEXT NOT NULL UNIQUE,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_checked_at TIMESTAMPTZ,
  error TEXT,
  CHECK (length(connection_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (metadata_json IS NULL OR jsonb_typeof(metadata_json) = 'object'),
  CHECK (updated_at >= created_at),
  UNIQUE (space_id, provider_id)
);

CREATE TABLE data.app_connector_channel_bindings (
  connection_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (connection_id, channel_id),
  CHECK (updated_at >= created_at)
);

CREATE TABLE data.app_source_relations (
  relation_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('repository', 'issue')),
  source_ref TEXT NOT NULL,
  features_json JSONB NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(relation_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at),
  UNIQUE (connection_id, channel_id, source_kind, source_ref)
);

CREATE TABLE data.app_connector_executions (
  execution_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  action_id TEXT,
  action_label TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'completed', 'failed', 'blocked', 'planned')),
  reason TEXT,
  connection_id TEXT,
  result_channel_id TEXT,
  result_summary TEXT,
  requested_by TEXT NOT NULL,
  requested_by_label TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(execution_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE INDEX app_connector_executions_space_idx
  ON data.app_connector_executions (space_id, created_at DESC, execution_id);

CREATE TABLE data.control_intents (
  intent_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  CHECK (length(intent_id) BETWEEN 1 AND 300),
  CHECK (length(kind) BETWEEN 1 AND 160),
  CHECK (length(scope_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE INDEX control_intents_status_idx
  ON data.control_intents (status, updated_at, intent_id);

CREATE TABLE data.management_work_items (
  work_item_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  evidence_channel_id TEXT NOT NULL,
  evidence_message_id TEXT NOT NULL,
  evidence_sequence BIGINT NOT NULL CHECK (evidence_sequence >= 1),
  evidence_hash TEXT NOT NULL,
  evidence_excerpt TEXT,
  state TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  payload_json JSONB NOT NULL,
  search_rank_sequence TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(work_item_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE INDEX management_work_items_space_state_idx
  ON data.management_work_items (space_id, state, updated_at, work_item_id);

CREATE TABLE data.management_work_item_transitions (
  work_item_id TEXT NOT NULL,
  transition_version BIGINT NOT NULL CHECK (transition_version >= 1),
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  detail_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (work_item_id, transition_version)
);

CREATE TABLE data.management_actions (
  action_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  work_item_id TEXT,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  evidence_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(action_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE TABLE data.assistant_memory_snapshots (
  owner_user_id TEXT PRIMARY KEY,
  snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (pg_column_size(snapshot_json) <= 1048576)
);

CREATE TABLE data.shared_memory_entries (
  owner_user_id TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  value_json JSONB NOT NULL,
  encoded_bytes BIGINT NOT NULL CHECK (encoded_bytes >= 0),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (owner_user_id, memory_key),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(memory_key) BETWEEN 1 AND 1000),
  CHECK (updated_at >= created_at)
);

CREATE INDEX shared_memory_entries_expiry_idx
  ON data.shared_memory_entries (expires_at, owner_user_id, memory_key)
  WHERE expires_at IS NOT NULL;

CREATE TABLE data.secret_catalog (
  owner_user_id TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json) = 'object'),
  display_name TEXT,
  default_env_name TEXT,
  description TEXT,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_user_id, secret_ref),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(secret_ref) BETWEEN 1 AND 1000),
  CHECK (updated_at >= created_at)
);

CREATE TABLE data.secret_grants (
  grant_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  daemon_request_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  secret_refs_json JSONB NOT NULL CHECK (jsonb_typeof(secret_refs_json) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('created', 'claimed', 'expired', 'revoked')),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (length(grant_id) BETWEEN 1 AND 300),
  CHECK (expires_at > created_at)
);

CREATE INDEX secret_grants_owner_status_idx
  ON data.secret_grants (owner_user_id, status, expires_at, grant_id);

CREATE TABLE data.secret_grant_audit (
  command_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  machine_id TEXT,
  host_id TEXT,
  secret_refs_json JSONB NOT NULL CHECK (jsonb_typeof(secret_refs_json) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (length(command_id) BETWEEN 1 AND 300),
  CHECK (length(grant_id) BETWEEN 1 AND 300)
);

CREATE TABLE data.trace_access_grants (
  grant_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_label TEXT,
  viewer_user_id TEXT NOT NULL,
  viewer_label TEXT,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  instance_id TEXT,
  channel_id TEXT,
  duration TEXT NOT NULL CHECK (duration IN ('permanent', 'channel', 'once')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'revoked', 'expired')),
  reason TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  requested_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  CHECK (length(grant_id) BETWEEN 1 AND 300)
);

CREATE INDEX trace_access_grants_viewer_idx
  ON data.trace_access_grants (viewer_user_id, requested_at DESC, grant_id);

CREATE INDEX trace_access_grants_owner_idx
  ON data.trace_access_grants (owner_user_id, requested_at DESC, grant_id);
