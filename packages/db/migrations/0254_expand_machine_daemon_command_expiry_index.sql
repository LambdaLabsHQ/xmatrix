-- xmatrix:online-indexes
-- The lifecycle now deletes expired daemon commands in bounded batches ordered
-- by expires_at. Without this index the eligibility count and every batch scan
-- the whole 439 MB table under a 5 s statement timeout. The partial predicate
-- matches only rows a delete can consider; NULL is never <= clock_timestamp().
CREATE INDEX CONCURRENTLY machine_daemon_commands_expiry_idx
  ON data.machine_daemon_commands (expires_at, command_id)
  WHERE expires_at IS NOT NULL;
