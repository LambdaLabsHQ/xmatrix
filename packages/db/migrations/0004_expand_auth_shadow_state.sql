CREATE TABLE control.auth_shadow_runs (
  source_store TEXT PRIMARY KEY,
  contract TEXT NOT NULL,
  snapshot_boundary BIGINT NOT NULL CHECK (snapshot_boundary >= 0),
  last_applied_event BIGINT NOT NULL DEFAULT 0 CHECK (last_applied_event >= 0),
  backfill_complete BOOLEAN NOT NULL DEFAULT FALSE,
  phase TEXT NOT NULL CHECK (phase IN ('backfill', 'shadow', 'verified', 'fenced', 'authoritative')),
  verified_event BIGINT CHECK (verified_event IS NULL OR verified_event >= 0),
  verified_digest_sha256 TEXT CHECK (
    verified_digest_sha256 IS NULL OR verified_digest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(source_store) BETWEEN 1 AND 300),
  CHECK (length(contract) BETWEEN 1 AND 160),
  CHECK (last_applied_event >= snapshot_boundary OR NOT backfill_complete),
  CHECK ((phase = 'verified' AND verified_event IS NOT NULL AND verified_digest_sha256 IS NOT NULL)
    OR phase <> 'verified')
);
CREATE TABLE control.auth_shadow_backfill_progress (
  source_store TEXT NOT NULL REFERENCES control.auth_shadow_runs (source_store) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  after_key TEXT,
  copied_rows BIGINT NOT NULL DEFAULT 0 CHECK (copied_rows >= 0),
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_store, source_table),
  CHECK (length(source_table) BETWEEN 1 AND 160),
  CHECK ((complete AND after_key IS NULL) OR NOT complete)
);
