CREATE TABLE data.durable_object_fact_archive (
  source_namespace TEXT NOT NULL,
  source_object_name TEXT NOT NULL,
  source_catalog_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_identity_key TEXT NOT NULL,
  source_schema_digest TEXT NOT NULL,
  source_row_json JSONB NOT NULL CHECK (jsonb_typeof(source_row_json) = 'object'),
  snapshot_token TEXT NOT NULL,
  imported_revision TEXT NOT NULL CHECK (imported_revision ~ '^[0-9a-f]{40}$'),
  copied_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (
    source_namespace,
    source_object_name,
    source_catalog_id,
    source_table,
    source_identity_key
  ),
  CHECK (length(source_namespace) BETWEEN 1 AND 160),
  CHECK (length(source_object_name) BETWEEN 1 AND 600),
  CHECK (length(source_catalog_id) BETWEEN 1 AND 160),
  CHECK (length(source_table) BETWEEN 1 AND 160),
  CHECK (length(source_identity_key) BETWEEN 1 AND 8192),
  CHECK (source_schema_digest ~ '^[0-9a-f]{64}$'),
  CHECK (length(snapshot_token) BETWEEN 1 AND 100)
);

CREATE INDEX durable_object_fact_archive_revision_idx
  ON data.durable_object_fact_archive (imported_revision, source_catalog_id, source_table);

CREATE INDEX durable_object_fact_archive_object_idx
  ON data.durable_object_fact_archive (
    source_namespace,
    source_object_name,
    source_catalog_id,
    source_table
  );
