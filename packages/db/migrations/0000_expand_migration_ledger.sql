CREATE SCHEMA IF NOT EXISTS control;
CREATE SCHEMA IF NOT EXISTS data;

CREATE TABLE IF NOT EXISTS control.schema_migrations (
  migration_id TEXT PRIMARY KEY,
  checksum_sha256 TEXT NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  phase TEXT NOT NULL CHECK (phase IN ('expand', 'contract')),
  app_revision TEXT NOT NULL,
  recovery_evidence_sha256 TEXT CHECK (
    recovery_evidence_sha256 IS NULL OR recovery_evidence_sha256 ~ '^[0-9a-f]{64}$'
  ),
  execution_ms BIGINT NOT NULL CHECK (execution_ms >= 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
