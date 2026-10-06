CREATE TABLE data.machine_daemon_activations (
  daemon_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  transaction_nonce_sha256 TEXT NOT NULL CHECK (length(transaction_nonce_sha256) = 64),
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  source_connection_epoch BIGINT NOT NULL CHECK (source_connection_epoch >= 1),
  provisional_connection_epoch BIGINT NOT NULL CHECK (provisional_connection_epoch >= 2),
  phase TEXT NOT NULL CHECK (phase IN (
    'recovering', 'activation_prepared', 'active_fenced', 'active', 'stable_granted', 'aborted'
  )),
  expected_run_ids_json JSONB NOT NULL CHECK (jsonb_typeof(expected_run_ids_json) = 'array'),
  expected_run_set_digest TEXT NOT NULL CHECK (length(expected_run_set_digest) = 64),
  run_set_digest TEXT,
  prepared_receipt_id TEXT,
  active_fenced_receipt_id TEXT,
  active_receipt_id TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX machine_daemon_activations_phase_idx
  ON data.machine_daemon_activations (phase, updated_at, daemon_id);
