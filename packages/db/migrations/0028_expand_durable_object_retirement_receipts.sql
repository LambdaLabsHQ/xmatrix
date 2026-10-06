CREATE TABLE control.durable_object_retirement_receipts (
  namespace TEXT NOT NULL,
  object_name TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  archive_rows INTEGER NOT NULL CHECK (archive_rows >= 1),
  pre_retirement_database_bytes BIGINT NOT NULL CHECK (pre_retirement_database_bytes >= 0),
  app_revision TEXT NOT NULL CHECK (app_revision ~ '^[0-9a-f]{40}$'),
  worker_version TEXT NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, object_name, catalog_id),
  CHECK (length(namespace) BETWEEN 1 AND 160),
  CHECK (length(object_name) BETWEEN 1 AND 600),
  CHECK (length(catalog_id) BETWEEN 1 AND 160),
  CHECK (length(worker_version) BETWEEN 1 AND 200)
);

CREATE INDEX durable_object_retirement_receipts_retired_at_idx
  ON control.durable_object_retirement_receipts (retired_at, namespace, object_name);
