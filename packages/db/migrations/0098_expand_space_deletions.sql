-- A Space owner's deletion of their Space. Scheduling removes every membership
-- in the same transaction, so every ordinary access check fails closed, and
-- keeps the removed memberships here so the owner can restore the Space until
-- purge_after. After that the purge worker deletes every Space-scoped fact in
-- bounded, resumable batches, and this row remains as the completed audit
-- record: who deleted which Space, when, and how much was removed.
CREATE TABLE data.space_deletions (
  space_id TEXT PRIMARY KEY,
  space_name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  purge_after TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'purging', 'completed')),
  -- Restore evidence; dropped once the purge begins and restore is impossible.
  members_json JSONB,
  automations_json JSONB,
  -- Next purge step: a stable step name plus the last key it finished.
  purge_step TEXT,
  purge_cursor TEXT,
  purged_rows BIGINT NOT NULL DEFAULT 0 CHECK (purged_rows >= 0),
  purged_objects BIGINT NOT NULL DEFAULT 0 CHECK (purged_objects >= 0),
  purge_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (char_length(space_name) <= 200),
  CHECK (purge_after > requested_at),
  CHECK ((state = 'scheduled') = (members_json IS NOT NULL AND automations_json IS NOT NULL)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK (state = 'scheduled' OR purge_started_at IS NOT NULL)
);

CREATE INDEX space_deletions_owner_idx
  ON data.space_deletions (owner_user_id, requested_at DESC, space_id)
  WHERE state = 'scheduled';

CREATE INDEX space_deletions_due_idx
  ON data.space_deletions (purge_after, space_id)
  WHERE state <> 'completed';
