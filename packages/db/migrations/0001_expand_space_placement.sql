CREATE TABLE control.postgres_shards (
  shard_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'draining', 'offline')),
  capacity_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(shard_id) BETWEEN 1 AND 300),
  CHECK (length(capacity_class) BETWEEN 1 AND 100)
);

CREATE TABLE control.space_placement (
  space_id TEXT PRIMARY KEY,
  shard_id TEXT NOT NULL REFERENCES control.postgres_shards (shard_id),
  placement_epoch BIGINT NOT NULL CHECK (placement_epoch >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'moving', 'blocked')),
  target_shard_id TEXT REFERENCES control.postgres_shards (shard_id),
  plan_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(plan_class) BETWEEN 1 AND 100),
  CHECK (
    (state = 'moving' AND target_shard_id IS NOT NULL AND target_shard_id <> shard_id)
    OR (state <> 'moving' AND target_shard_id IS NULL)
  )
);

CREATE INDEX space_placement_shard_idx
  ON control.space_placement (shard_id, space_id);

CREATE INDEX space_placement_target_idx
  ON control.space_placement (target_shard_id, space_id)
  WHERE target_shard_id IS NOT NULL;
