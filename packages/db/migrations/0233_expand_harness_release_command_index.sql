-- xmatrix:online-indexes
-- The harness release watch runs once a minute and asks, for every preset and
-- every capable Machine, whether a recent `release` command already exists.
-- The claim index leads with status, so that anti-join could not use its
-- created_at suffix and scanned every command the Machine had ever stored
-- (about 15k rows including payload TOAST) once per preset: roughly 150k
-- shared buffer hits per pass against a 2 GB origin (XMATRIX-HUB-BD). This
-- partial index turns each probe into a bounded lookup of the release
-- notices that actually exist.
CREATE INDEX CONCURRENTLY machine_daemon_commands_harness_release_idx
  ON data.machine_daemon_commands
    (owner_user_id, machine_id, (payload_json->>'presetId'), created_at)
  WHERE command_type = 'harness_action' AND payload_json->>'action' = 'release';
