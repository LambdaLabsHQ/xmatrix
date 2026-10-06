-- An owner-approved, read-only grant that lets one exact live Agent Run read a
-- Channel family (or a whole Space) outside the Space it was launched in
-- (docs/cross-space-read-grants.md). The row lives in the target Space, whose
-- authority evaluates every read; the source Run is re-proven in its own Space.
-- channel_id is the Channel the request named; scope 'space' widens coverage to
-- its whole Space, and the owner may narrow it back to 'channel' on approval.
CREATE TABLE data.cross_space_read_grants (
  grant_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('channel', 'space')),
  owner_user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  run_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  execution_key_digest TEXT NOT NULL,
  source_space_id TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  notice_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'revoked', 'expired')),
  reason TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  read_count BIGINT NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  requested_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  last_read_at TIMESTAMPTZ,
  CHECK (length(grant_id) BETWEEN 1 AND 300),
  CHECK (space_id <> source_space_id),
  CHECK (reason IS NULL OR char_length(reason) <= 500),
  CHECK (agent_name IS NULL OR char_length(agent_name) <= 200)
);

-- One open request or grant per Run and target; a new request reuses it. A
-- Space-wide grant is one target however many Channels it was requested from.
CREATE UNIQUE INDEX cross_space_read_grants_open_idx
  ON data.cross_space_read_grants
    (run_id, space_id, scope, (CASE WHEN scope = 'space' THEN '' ELSE channel_id END))
  WHERE status IN ('pending', 'approved');

CREATE INDEX cross_space_read_grants_space_idx
  ON data.cross_space_read_grants (space_id, requested_at DESC, grant_id);

CREATE INDEX cross_space_read_grants_run_idx
  ON data.cross_space_read_grants (run_id, status, grant_id);
