-- Where a pending cross-Space read request waits for its owner
-- (docs/cross-space-read-grants.md). The grant itself lives in the target
-- Space; this row lives in the requesting Run's Space, so that Channel can list
-- the approvals waiting for its viewer without reading any other Space. It is a
-- locator only: every listed grant is re-read from its own Space before display.
CREATE TABLE data.cross_space_read_notices (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_space_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, grant_id),
  CHECK (length(grant_id) BETWEEN 1 AND 300),
  CHECK (space_id <> grant_space_id)
);

CREATE INDEX cross_space_read_notices_channel_idx
  ON data.cross_space_read_notices (space_id, channel_id, owner_user_id, expires_at DESC);
