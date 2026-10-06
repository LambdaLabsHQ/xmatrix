CREATE TABLE data.human_profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  handle TEXT,
  avatar_url TEXT,
  bio TEXT,
  handle_is_temporary BOOLEAN NOT NULL,
  profile_version BIGINT NOT NULL CHECK (profile_version >= 0),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX human_profiles_handle_idx
  ON data.human_profiles (handle) WHERE handle IS NOT NULL;

CREATE TABLE data.agent_profile_creation_requests (
  request_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  runtime TEXT NOT NULL,
  metadata_json JSONB NOT NULL,
  source TEXT NOT NULL,
  requested_by_principal TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decided_by_user_id TEXT
);

CREATE INDEX agent_profile_creation_requests_space_status_idx
  ON data.agent_profile_creation_requests (space_id, status, created_at, request_id);

CREATE TABLE data.machine_daemons (
  daemon_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  host_name TEXT,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('enrolled', 'online', 'offline')),
  capabilities_json JSONB NOT NULL,
  metadata_json JSONB NOT NULL,
  connection_epoch BIGINT NOT NULL CHECK (connection_epoch >= 0),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (owner_user_id, machine_id, host_id)
);

CREATE INDEX machine_daemons_owner_status_idx
  ON data.machine_daemons (owner_user_id, status, updated_at, daemon_id);

CREATE TABLE data.machine_run_routes (
  run_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ
);

CREATE INDEX machine_run_routes_machine_idx
  ON data.machine_run_routes
    (owner_user_id, machine_id, host_id, terminal_at, updated_at, run_id);

CREATE TABLE data.machine_daemon_commands (
  command_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  command_type TEXT NOT NULL CHECK (command_type IN ('spawn', 'stop', 'cleanup', 'request_resolve')),
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  lease_until TIMESTAMPTZ,
  result_json JSONB,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX machine_daemon_commands_claim_idx
  ON data.machine_daemon_commands
    (owner_user_id, machine_id, host_id, status, created_at, command_id);

CREATE TABLE data.machine_daemon_control_audit (
  command_id TEXT PRIMARY KEY,
  daemon_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  event_type TEXT,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX machine_daemon_control_audit_daemon_idx
  ON data.machine_daemon_control_audit (daemon_id, created_at, command_id);

CREATE TABLE data.machine_secret_requests (
  request_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  requested_secrets_json JSONB NOT NULL,
  notice_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'resolved')),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX machine_secret_requests_owner_status_idx
  ON data.machine_secret_requests (owner_user_id, status, created_at, request_id);

CREATE TABLE data.secret_instance_approvals (
  approval_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  execution_key TEXT NOT NULL,
  machine_id TEXT,
  host_id TEXT,
  cwd TEXT,
  argv_json JSONB NOT NULL,
  secret_refs_json JSONB NOT NULL,
  secret_versions_json JSONB NOT NULL,
  approved_by TEXT NOT NULL,
  approved_by_label TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX secret_instance_approvals_owner_status_idx
  ON data.secret_instance_approvals (owner_user_id, status, instance_id, approval_id);

CREATE TABLE data.secret_instance_resolutions (
  owner_user_id TEXT NOT NULL,
  daemon_request_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_user_id, daemon_request_id)
);

CREATE TABLE data.dangerous_action_requests (
  request_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'executed', 'expired')),
  execution_grant_hash TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ
);

CREATE INDEX dangerous_action_requests_owner_status_idx
  ON data.dangerous_action_requests (owner_user_id, status, expires_at, request_id);

CREATE TABLE data.space_action_claims (
  claim_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  intent TEXT NOT NULL,
  holder_user_id TEXT NOT NULL,
  holder_json JSONB NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  released_by_user_id TEXT
);

CREATE UNIQUE INDEX space_action_claims_active_scope_idx
  ON data.space_action_claims (space_id, scope, intent) WHERE status = 'active';

CREATE INDEX space_action_claims_space_status_idx
  ON data.space_action_claims (space_id, status, expires_at, claim_id);

ALTER TABLE data.secret_grants ADD COLUMN channel_id TEXT;
ALTER TABLE data.secret_grants ADD COLUMN run_id TEXT;
ALTER TABLE data.secret_grants ADD COLUMN instance_id TEXT;
ALTER TABLE data.secret_grants ADD COLUMN execution_key TEXT;
ALTER TABLE data.secret_grants ADD COLUMN cwd TEXT;
ALTER TABLE data.secret_grants ADD COLUMN secret_versions_json JSONB;
