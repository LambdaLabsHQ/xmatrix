CREATE TABLE control.entity_space_routes (
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  placement_epoch BIGINT NOT NULL CHECK (placement_epoch >= 1),
  entity_version BIGINT NOT NULL CHECK (entity_version >= 1),
  route_version BIGINT NOT NULL CHECK (route_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (entity_kind, entity_id),
  CHECK (length(entity_kind) BETWEEN 1 AND 100),
  CHECK (length(entity_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(shard_id) BETWEEN 1 AND 300)
);

CREATE INDEX entity_space_routes_space_idx
  ON control.entity_space_routes (space_id, entity_kind, entity_id)
  WHERE state = 'active';
