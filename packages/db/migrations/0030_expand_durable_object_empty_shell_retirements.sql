CREATE TABLE control.durable_object_empty_shell_retirement_receipts (
  namespace TEXT NOT NULL,
  object_name TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  compaction_evidence_digest TEXT NOT NULL
    CHECK (compaction_evidence_digest ~ '^[0-9a-f]{64}$'),
  snapshot_digest TEXT NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  compacted_database_bytes BIGINT NOT NULL CHECK (compacted_database_bytes BETWEEN 1 AND 131072),
  deleted_database_bytes BIGINT CHECK (deleted_database_bytes BETWEEN 1 AND 131072),
  app_revision TEXT NOT NULL CHECK (app_revision ~ '^[0-9a-f]{40}$'),
  worker_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'complete')),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (namespace, object_name, catalog_id),
  CHECK (length(namespace) BETWEEN 1 AND 160),
  CHECK (length(object_name) BETWEEN 1 AND 600),
  CHECK (length(catalog_id) BETWEEN 1 AND 160),
  CHECK (length(worker_version) BETWEEN 1 AND 200),
  CHECK (
    (state = 'prepared' AND deleted_database_bytes IS NULL AND completed_at IS NULL) OR
    (state = 'complete' AND deleted_database_bytes IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX durable_object_empty_shell_retirements_state_idx
  ON control.durable_object_empty_shell_retirement_receipts
  (state, prepared_at, namespace, object_name);
