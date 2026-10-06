CREATE TABLE control.durable_object_compactions (
  namespace TEXT NOT NULL,
  object_name TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  snapshot_digest TEXT NOT NULL CHECK (snapshot_digest ~ '^[0-9a-f]{64}$'),
  snapshot_json JSONB NOT NULL,
  snapshot_rows INTEGER NOT NULL CHECK (snapshot_rows BETWEEN 0 AND 20000),
  pre_compaction_database_bytes BIGINT NOT NULL CHECK (pre_compaction_database_bytes >= 0),
  post_compaction_database_bytes BIGINT CHECK (post_compaction_database_bytes >= 0),
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
    (state = 'prepared' AND post_compaction_database_bytes IS NULL AND completed_at IS NULL) OR
    (state = 'complete' AND post_compaction_database_bytes IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX durable_object_compactions_state_idx
  ON control.durable_object_compactions (state, prepared_at, namespace, object_name);
