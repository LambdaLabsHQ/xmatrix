CREATE TABLE control.channel_space_routes (
  channel_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  placement_epoch BIGINT NOT NULL CHECK (placement_epoch >= 1),
  entity_version BIGINT NOT NULL CHECK (entity_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(shard_id) BETWEEN 1 AND 300)
);

CREATE INDEX channel_space_routes_space_idx
  ON control.channel_space_routes (space_id, placement_epoch, channel_id)
  WHERE state = 'active';

CREATE TABLE control.user_space_membership_routes (
  user_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  shard_id TEXT NOT NULL,
  placement_epoch BIGINT NOT NULL CHECK (placement_epoch >= 1),
  membership_version BIGINT NOT NULL CHECK (membership_version >= 1),
  route_version BIGINT NOT NULL CHECK (route_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, space_id),
  CHECK (length(user_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(shard_id) BETWEEN 1 AND 300)
);

CREATE INDEX user_space_membership_routes_user_idx
  ON control.user_space_membership_routes (user_id, space_id)
  WHERE state = 'active';
