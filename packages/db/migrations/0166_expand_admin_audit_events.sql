-- Every platform-admin read and action leaves a row an operator answers for.
-- Metadata only: who, what kind of read or action, which target id, and when.
CREATE TABLE control.admin_audit_events (
  event_id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (length(event_id) BETWEEN 1 AND 300),
  CHECK (length(actor_user_id) BETWEEN 1 AND 300),
  CHECK (actor_email IS NULL OR length(actor_email) BETWEEN 1 AND 320),
  CHECK (length(action) BETWEEN 1 AND 80),
  CHECK (target_kind IS NULL OR length(target_kind) BETWEEN 1 AND 80),
  CHECK (target_id IS NULL OR length(target_id) BETWEEN 1 AND 300)
);

CREATE INDEX admin_audit_events_recent_idx
  ON control.admin_audit_events (created_at DESC, event_id);
