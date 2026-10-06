CREATE TABLE control.postgres_local_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  shard_id TEXT NOT NULL REFERENCES control.postgres_shards (shard_id),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (length(shard_id) BETWEEN 1 AND 300)
);

CREATE TABLE control.space_shard_movements (
  movement_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL REFERENCES control.postgres_shards (shard_id),
  target_shard_id TEXT NOT NULL REFERENCES control.postgres_shards (shard_id),
  source_placement_epoch BIGINT NOT NULL CHECK (source_placement_epoch >= 1),
  target_placement_epoch BIGINT NOT NULL CHECK (target_placement_epoch >= 2),
  phase TEXT NOT NULL CHECK (phase IN (
    'copying', 'catching_up', 'caught_up', 'verified', 'frozen',
    'final_copied', 'final_verified', 'rollback_window', 'completed', 'aborted'
  )),
  snapshot_commit_sequence BIGINT CHECK (snapshot_commit_sequence >= 0),
  caught_up_commit_sequence BIGINT CHECK (caught_up_commit_sequence >= 0),
  final_commit_sequence BIGINT CHECK (final_commit_sequence >= 0),
  source_digest_sha256 TEXT,
  target_digest_sha256 TEXT,
  copied_rows BIGINT NOT NULL DEFAULT 0 CHECK (copied_rows >= 0),
  copied_bytes BIGINT NOT NULL DEFAULT 0 CHECK (copied_bytes >= 0),
  rollback_window_seconds BIGINT NOT NULL CHECK (rollback_window_seconds >= 3600),
  frozen_at TIMESTAMPTZ,
  cutover_at TIMESTAMPTZ,
  rollback_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  aborted_at TIMESTAMPTZ,
  last_error TEXT,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (source_shard_id <> target_shard_id),
  CHECK (target_placement_epoch = source_placement_epoch + 1),
  CHECK (source_digest_sha256 IS NULL OR source_digest_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (target_digest_sha256 IS NULL OR target_digest_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK ((phase IN ('rollback_window', 'completed')) = (cutover_at IS NOT NULL)),
  CHECK ((phase = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((phase = 'aborted') = (aborted_at IS NOT NULL))
);

CREATE UNIQUE INDEX space_shard_movements_epoch_idx
  ON control.space_shard_movements (space_id, source_placement_epoch);

CREATE UNIQUE INDEX space_shard_movements_active_idx
  ON control.space_shard_movements (space_id)
  WHERE phase NOT IN ('completed', 'aborted');

CREATE INDEX space_shard_movements_phase_idx
  ON control.space_shard_movements (phase, updated_at, movement_id);
