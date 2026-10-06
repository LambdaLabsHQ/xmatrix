-- Instance and Run ids become their natural keys
-- (docs/architecture/instance-run-natural-keys.md):
--   Instance   <channel_id>:<channel_instance_id>
--   Run        <channel_id>:<channel_instance_id>#<k>
--   About Run  <channel_id>:about#<k>
--
-- Ids used to be minted before the Channel ordinal existed and doubled as the
-- idempotency key of their creation path. An ordinal is now reserved first,
-- keyed by that creation key, so a replay receives the same ids. Counters are
-- per Channel scope: `instance` for Instance ordinals, `about` for About Runs,
-- and `run:<ordinal>` for the starts of one Instance. They never go backwards,
-- so an ordinal is never reused.

CREATE TABLE data.natural_key_counters (
  channel_id TEXT NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 300),
  scope TEXT NOT NULL CHECK (scope IN ('instance','about') OR scope ~ '^run:[1-9][0-9]{0,15}$'),
  last_value BIGINT NOT NULL CHECK (last_value >= 0),
  PRIMARY KEY (channel_id, scope)
);

CREATE TABLE data.natural_key_reservations (
  creation_key TEXT PRIMARY KEY CHECK (length(creation_key) BETWEEN 1 AND 300),
  channel_id TEXT NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 300),
  channel_instance_id BIGINT CHECK (channel_instance_id >= 1),
  run_ordinal BIGINT NOT NULL CHECK (run_ordinal >= 1),
  created_at TIMESTAMPTZ NOT NULL
);
