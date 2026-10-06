CREATE TABLE data.slack_oauth_sessions (
  grant_id TEXT PRIMARY KEY,
  oauth_state TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 1 AND 30),
  secret_ref TEXT,
  team_name TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  start_command_id TEXT NOT NULL,
  approve_command_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  CHECK (length(grant_id) BETWEEN 1 AND 300),
  CHECK (length(oauth_state) BETWEEN 1 AND 300),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (secret_ref IS NULL OR length(secret_ref) BETWEEN 1 AND 1000),
  CHECK (updated_at >= created_at),
  CHECK (expires_at > created_at),
  CHECK ((status = 'pending' AND secret_ref IS NULL AND approved_at IS NULL
      AND consumed_at IS NULL)
    OR (status = 'approved' AND secret_ref IS NOT NULL AND approved_at IS NOT NULL
      AND consumed_at IS NULL)
    OR (status = 'consumed' AND approved_at IS NOT NULL AND consumed_at IS NOT NULL)
    OR status = 'expired')
);

CREATE INDEX slack_oauth_sessions_owner_idx
  ON data.slack_oauth_sessions (owner_user_id, created_at DESC, grant_id);

CREATE INDEX slack_oauth_sessions_expiry_idx
  ON data.slack_oauth_sessions (expires_at, grant_id)
  WHERE status IN ('pending', 'approved');
