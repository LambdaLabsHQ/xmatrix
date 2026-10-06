CREATE TABLE control.legacy_postgres_sync_runs (
  run_id TEXT PRIMARY KEY,
  source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  source_worker_version TEXT NOT NULL,
  source_inventory_digest TEXT NOT NULL CHECK (source_inventory_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'failed', 'abandoned')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  last_scan_at TIMESTAMPTZ,
  CHECK (length(run_id) BETWEEN 8 AND 100),
  CHECK (length(source_worker_version) BETWEEN 1 AND 200),
  CHECK ((state = 'complete' AND completed_at IS NOT NULL) OR state <> 'complete')
);

CREATE TABLE control.legacy_postgres_sync_rows (
  domain TEXT NOT NULL,
  target_schema TEXT NOT NULL,
  target_table TEXT NOT NULL,
  identity_digest TEXT NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
  identity_json JSONB NOT NULL CHECK (jsonb_typeof(identity_json) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('imported', 'postgres_owned', 'postgres_deleted')),
  last_source_digest TEXT NOT NULL CHECK (last_source_digest ~ '^[0-9a-f]{64}$'),
  last_promoted_postgres_digest TEXT CHECK (
    last_promoted_postgres_digest IS NULL OR
    last_promoted_postgres_digest ~ '^[0-9a-f]{64}$'
  ),
  first_run_id TEXT NOT NULL REFERENCES control.legacy_postgres_sync_runs(run_id),
  last_run_id TEXT NOT NULL REFERENCES control.legacy_postgres_sync_runs(run_id),
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  conflict_at TIMESTAMPTZ,
  PRIMARY KEY (domain, target_schema, target_table, identity_digest),
  CHECK (length(domain) BETWEEN 1 AND 100),
  CHECK (target_schema IN ('control', 'data')),
  CHECK (length(target_table) BETWEEN 1 AND 160),
  CHECK (
    (state = 'imported' AND last_promoted_postgres_digest IS NOT NULL AND conflict_at IS NULL) OR
    (state = 'postgres_owned' AND conflict_at IS NOT NULL) OR
    (state = 'postgres_deleted' AND last_promoted_postgres_digest IS NOT NULL AND conflict_at IS NOT NULL)
  )
);

CREATE INDEX legacy_postgres_sync_rows_state_idx
  ON control.legacy_postgres_sync_rows (state, domain, target_schema, target_table);

CREATE INDEX legacy_postgres_sync_rows_run_idx
  ON control.legacy_postgres_sync_rows (last_run_id, domain, target_schema, target_table);

CREATE TABLE control.legacy_postgres_sync_conflicts (
  conflict_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES control.legacy_postgres_sync_runs(run_id),
  domain TEXT NOT NULL,
  target_schema TEXT NOT NULL,
  target_table TEXT NOT NULL,
  identity_digest TEXT NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK (reason IN ('postgres_preexisting', 'postgres_changed', 'postgres_deleted')),
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  expected_postgres_digest TEXT CHECK (
    expected_postgres_digest IS NULL OR expected_postgres_digest ~ '^[0-9a-f]{64}$'
  ),
  observed_postgres_digest TEXT CHECK (
    observed_postgres_digest IS NULL OR observed_postgres_digest ~ '^[0-9a-f]{64}$'
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, domain, target_schema, target_table, identity_digest, reason),
  CHECK (target_schema IN ('control', 'data'))
);

CREATE TABLE control.authority_cutovers (
  cutover_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  authority TEXT NOT NULL,
  target_revision TEXT NOT NULL CHECK (target_revision ~ '^[0-9a-f]{40}$'),
  sync_run_id TEXT NOT NULL REFERENCES control.legacy_postgres_sync_runs(run_id),
  pre_cutover_receipt JSONB NOT NULL CHECK (jsonb_typeof(pre_cutover_receipt) = 'object'),
  activated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (authority),
  CHECK (length(authority) BETWEEN 1 AND 100)
);
