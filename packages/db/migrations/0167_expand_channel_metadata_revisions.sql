-- Current metadata remains on channels. These records retain complete content
-- and the authoritative input windows; legacy history cannot be reconstructed.
CREATE TABLE data.channel_metadata_revisions (
  space_id TEXT NOT NULL,
  origin_space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES data.channels(channel_id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  parent_revision BIGINT,
  name TEXT NOT NULL,
  summary TEXT,
  auto_name BOOLEAN NOT NULL,
  summary_source_json JSONB,
  source_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (channel_id, revision),
  CHECK (parent_revision IS NULL OR parent_revision = revision - 1)
);
CREATE INDEX channel_metadata_revisions_space_idx ON data.channel_metadata_revisions(space_id, channel_id);

CREATE TABLE data.channel_about_inputs (
  space_id TEXT NOT NULL,
  origin_space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES data.channels(channel_id) ON DELETE CASCADE,
  input_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  metadata_revision BIGINT NOT NULL CHECK (metadata_revision >= 0),
  snapshot_json JSONB NOT NULL,
  references_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (jsonb_typeof(references_json) = 'array' AND jsonb_array_length(references_json) <= 200)
);
CREATE INDEX channel_about_inputs_run_idx ON data.channel_about_inputs(channel_id, run_id, created_at, input_id);
CREATE INDEX channel_about_inputs_space_idx ON data.channel_about_inputs(space_id, channel_id);

-- The storage scope follows a confirmed Channel transfer; original scope and
-- every content/provenance field stay immutable. Retention deletion is separate.
CREATE FUNCTION data.protect_channel_metadata_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'space_id') IS DISTINCT FROM (to_jsonb(OLD) - 'space_id') THEN
    RAISE EXCEPTION 'Channel metadata history is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER channel_metadata_revisions_immutable BEFORE UPDATE ON data.channel_metadata_revisions
  FOR EACH ROW EXECUTE FUNCTION data.protect_channel_metadata_history();
CREATE TRIGGER channel_about_inputs_immutable BEFORE UPDATE ON data.channel_about_inputs
  FOR EACH ROW EXECUTE FUNCTION data.protect_channel_metadata_history();
