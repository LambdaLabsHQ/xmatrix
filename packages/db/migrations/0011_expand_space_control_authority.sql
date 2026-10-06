CREATE SEQUENCE data.search_rank_sequence_v1 AS BIGINT START WITH 1;

CREATE TABLE data.space_control_heads (
  space_id TEXT PRIMARY KEY,
  commit_sequence BIGINT NOT NULL DEFAULT 0 CHECK (commit_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300)
);

CREATE TABLE control.user_space_memberships (
  user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  membership_version BIGINT NOT NULL CHECK (membership_version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, space_id),
  CHECK (length(user_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300)
);

CREATE INDEX user_space_memberships_space_idx
  ON control.user_space_memberships (space_id, user_id);

CREATE TABLE control.channel_space_directory (
  channel_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300)
);

CREATE INDEX channel_space_directory_space_idx
  ON control.channel_space_directory (space_id, channel_id);
