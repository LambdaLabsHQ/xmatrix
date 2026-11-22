-- Durable cleanup leases for temporary Gmail upload snapshots staged in R2.
-- Each lease binds one exact connector-mail-snapshots/<token> object key and
-- expiry deadline before R2 put so interrupted staging or failed immediate
-- deletes are recovered by the bounded expiry reconciler without touching
-- ordinary attachment objects. Older Hubs ignore this table while draining.
CREATE TABLE control.connector_mail_snapshot_leases (
  object_key TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'staged',
  expires_at TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (object_key ~ '^connector-mail-snapshots/[A-Za-z0-9_-]{43}$'),
  CHECK (length(command_id) BETWEEN 1 AND 200),
  CHECK (state IN ('staged', 'delete_pending')),
  CHECK (attempts >= 0)
);

CREATE INDEX connector_mail_snapshot_leases_due_idx
  ON control.connector_mail_snapshot_leases (next_attempt_at, object_key);
