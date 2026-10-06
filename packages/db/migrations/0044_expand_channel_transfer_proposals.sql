CREATE TABLE data.channel_transfer_proposals (
  space_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  target_space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  target_parent_id TEXT,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_by_id TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  outbound_user_id TEXT,
  outbound_at TIMESTAMPTZ,
  inbound_user_id TEXT,
  inbound_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (space_id, proposal_id),
  CHECK (space_id <> target_space_id),
  CHECK ((outbound_user_id IS NULL) = (outbound_at IS NULL)),
  CHECK ((inbound_user_id IS NULL) = (inbound_at IS NULL)),
  CHECK (status <> 'completed' OR
    (outbound_user_id IS NOT NULL AND inbound_user_id IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX channel_transfer_source_queue_idx
  ON data.channel_transfer_proposals (space_id, created_at DESC, proposal_id);
CREATE INDEX channel_transfer_target_queue_idx
  ON data.channel_transfer_proposals (target_space_id, created_at DESC, proposal_id);
CREATE INDEX channel_transfer_tree_queue_idx
  ON data.channel_transfer_proposals (channel_id, created_at DESC, proposal_id);
