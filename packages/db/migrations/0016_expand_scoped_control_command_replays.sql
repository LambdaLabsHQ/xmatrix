CREATE TABLE control.scoped_control_command_replays (
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, command_id)
);

CREATE INDEX scoped_control_command_replays_expiry_idx
  ON control.scoped_control_command_replays (expires_at, scope_kind, scope_id, command_id);
