CREATE TABLE data.machine_run_snapshot_heads (
  owner_user_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  connection_epoch BIGINT NOT NULL CHECK (connection_epoch >= 1),
  registry_sequence BIGINT NOT NULL CHECK (registry_sequence >= 1),
  captured_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_user_id, machine_id, host_id, channel_id),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(machine_id) BETWEEN 1 AND 160),
  CHECK (length(host_id) BETWEEN 1 AND 160),
  CHECK (length(channel_id) BETWEEN 1 AND 300)
);

CREATE INDEX machine_run_snapshot_heads_channel_idx
  ON data.machine_run_snapshot_heads (channel_id, updated_at);
