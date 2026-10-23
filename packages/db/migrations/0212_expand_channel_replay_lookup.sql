-- No production shard applied the original transactional index build: the
-- release's 25-second deadline rolled it back before its ledger receipt.
-- Reserve exact online index identities before their nontransactional builds.
CREATE TABLE control.schema_migration_index_builds (
  index_schema text NOT NULL CHECK (index_schema IN ('control','data')),
  index_name text NOT NULL,
  migration_id text NOT NULL,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  statement_sha256 text NOT NULL CHECK (statement_sha256 ~ '^[a-f0-9]{64}$'),
  table_schema text NOT NULL,
  table_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (index_schema,index_name)
);
