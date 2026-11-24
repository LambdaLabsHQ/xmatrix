-- A support handoff (docs/cross-space-read-grants.md#support-handoffs): a person
-- hands one of their Channels to xMatrix support. It is the same read-only,
-- expiring, revocable grant an Agent Run asks for, with a different grantee:
-- the support Space (source_space_id) instead of one exact Run. Its readers are
-- that Space's members and the live Runs launched in it, each read is made as
-- the person who handed it over (owner_user_id), and only the parts they ticked
-- are readable.
--
-- grantee: 'run' (NULL on rows written before this column) or 'space'.
-- parts: what a 'space' grant covers, a subset of messages, diagnostics, logs;
--   an empty set hands over only the person's line (reason).
-- log_excerpt: the daemon log tail the person previewed, already redacted on
--   their machine; cleared when the grant is revoked.
-- access_noted_at: when the person's Channel was last told that support read it,
--   so the note is posted at most once an hour.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.cross_space_read_grants ADD COLUMN grantee TEXT;
ALTER TABLE data.cross_space_read_grants ADD COLUMN parts TEXT[];
ALTER TABLE data.cross_space_read_grants ADD COLUMN log_excerpt TEXT;
ALTER TABLE data.cross_space_read_grants ADD COLUMN access_noted_at TIMESTAMPTZ;
ALTER TABLE data.cross_space_read_grants ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE data.cross_space_read_grants ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE data.cross_space_read_grants ALTER COLUMN instance_id DROP NOT NULL;
ALTER TABLE data.cross_space_read_grants ALTER COLUMN execution_key_digest DROP NOT NULL;
ALTER TABLE data.cross_space_read_grants ADD CONSTRAINT cross_space_read_grants_grantee_shape CHECK (
  CASE COALESCE(grantee, 'run')
    WHEN 'run' THEN agent_id IS NOT NULL AND run_id IS NOT NULL AND instance_id IS NOT NULL
      AND execution_key_digest IS NOT NULL AND parts IS NULL AND log_excerpt IS NULL
      AND access_noted_at IS NULL
    WHEN 'space' THEN scope = 'channel' AND agent_id IS NULL AND run_id IS NULL AND instance_id IS NULL
      AND execution_key_digest IS NULL AND parts IS NOT NULL
      AND parts <@ ARRAY['messages', 'diagnostics', 'logs']::TEXT[]
      AND (log_excerpt IS NULL OR ('logs' = ANY (parts) AND char_length(log_excerpt) <= 16000))
    ELSE FALSE
  END) NOT VALID;
ALTER TABLE data.cross_space_read_grants VALIDATE CONSTRAINT cross_space_read_grants_grantee_shape;

-- A support reader finds the live handoffs of the Channel it reads.
CREATE INDEX cross_space_read_grants_support_idx
  ON data.cross_space_read_grants (space_id, channel_id, source_space_id, status)
  WHERE grantee = 'space';
