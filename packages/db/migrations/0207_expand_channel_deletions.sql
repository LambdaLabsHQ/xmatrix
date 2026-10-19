-- A retired Channel is immediately unreadable. Its row remains until bounded
-- cleanup has removed its closure, including metadata history's foreign key.
CREATE TABLE data.channel_deletions (
  channel_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN ('purging','completed')),
  step INTEGER NOT NULL DEFAULT 0 CHECK (step >= 0),
  object_cursor TEXT NOT NULL DEFAULT '',
  objects_done BOOLEAN NOT NULL DEFAULT false,
  purged_rows BIGINT NOT NULL DEFAULT 0 CHECK (purged_rows >= 0),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(requested_by) BETWEEN 1 AND 300)
);
CREATE INDEX channel_deletions_pending_idx ON data.channel_deletions(updated_at,channel_id)
  WHERE state='purging';
CREATE INDEX channel_deletions_space_idx ON data.channel_deletions(space_id,channel_id);

-- A delayed create cannot reuse a retired identity. Ordinary deletion of its
-- row remains the purge's last step; metadata mutations refuse deleted mode.
CREATE FUNCTION data.protect_retired_channel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM data.channel_deletions WHERE channel_id=NEW.channel_id) THEN
    RAISE EXCEPTION 'Channel identity is retired' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_retirement_insert BEFORE INSERT ON data.channels
  FOR EACH ROW EXECUTE FUNCTION data.protect_retired_channel();
