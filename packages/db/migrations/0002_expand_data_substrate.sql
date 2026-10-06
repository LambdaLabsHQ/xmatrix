CREATE TABLE data.idempotency_keys (
  space_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result_json JSONB NOT NULL,
  commit_sequence BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, idempotency_key),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  CHECK (length(command_kind) BETWEEN 1 AND 160),
  CHECK (commit_sequence IS NULL OR commit_sequence >= 1),
  CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_keys_expiry_idx
  ON data.idempotency_keys (expires_at, space_id, idempotency_key);

CREATE TABLE data.outbox (
  outbox_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_sequence BIGINT NOT NULL CHECK (aggregate_sequence >= 1),
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  available_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(outbox_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(topic) BETWEEN 1 AND 160),
  CHECK (length(aggregate_kind) BETWEEN 1 AND 160),
  CHECK (length(aggregate_id) BETWEEN 1 AND 300),
  CHECK ((status = 'leased' AND lease_until IS NOT NULL) OR status <> 'leased'),
  UNIQUE (space_id, topic, aggregate_kind, aggregate_id, aggregate_sequence)
);

CREATE INDEX outbox_delivery_idx
  ON data.outbox (available_at, outbox_id)
  WHERE status IN ('pending', 'failed');

CREATE TABLE data.space_storage_usage (
  space_id TEXT NOT NULL,
  category TEXT NOT NULL,
  logical_rows BIGINT NOT NULL DEFAULT 0 CHECK (logical_rows >= 0),
  logical_bytes BIGINT NOT NULL DEFAULT 0 CHECK (logical_bytes >= 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, category),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(category) BETWEEN 1 AND 160)
);
