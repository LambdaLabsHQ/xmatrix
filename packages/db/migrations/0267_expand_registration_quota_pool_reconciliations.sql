-- Per-pool durable reconciliation ledger for quota waiter recovery (#1343).
-- Records an observation revision and pending reconciliation obligation
-- atomically with each pool observation, plus a resumable channel cursor so
-- bounded waiter reconciliation drains every eligible wait without owner-wide
-- prefix starvation or extra provider requests. Older Hubs ignore this table.
CREATE TABLE control.registration_quota_pool_reconciliations (
  owner_user_id TEXT NOT NULL,
  quota_pool_id TEXT NOT NULL,
  observation_revision BIGINT NOT NULL DEFAULT 0 CHECK (observation_revision >= 0),
  reconcile_needed_revision BIGINT NOT NULL DEFAULT 0 CHECK (reconcile_needed_revision >= 0),
  reconciled_revision BIGINT NOT NULL DEFAULT 0 CHECK (reconciled_revision >= 0),
  reconcile_cursor_channel_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_user_id, quota_pool_id),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(quota_pool_id) BETWEEN 1 AND 300),
  CHECK (reconcile_needed_revision <= observation_revision),
  CHECK (reconciled_revision <= reconcile_needed_revision),
  CHECK (reconcile_cursor_channel_id IS NULL OR length(reconcile_cursor_channel_id) BETWEEN 1 AND 180)
);

CREATE INDEX registration_quota_pool_reconciliations_due_idx
  ON control.registration_quota_pool_reconciliations (updated_at, owner_user_id, quota_pool_id)
  WHERE reconcile_needed_revision > reconciled_revision;
