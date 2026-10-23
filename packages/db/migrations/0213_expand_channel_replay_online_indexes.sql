-- xmatrix:online-indexes
-- Only Channel identities, never complete replay payloads. The migrator
-- reserves each absent name durably, builds outside a transaction without
-- blocking writers, verifies readiness, then commits the normal ledger receipt.
CREATE INDEX CONCURRENTLY scoped_replays_channel_purge_idx ON control.scoped_control_command_replays USING gin
  ((ARRAY[CASE WHEN scope_kind='channel' THEN scope_id END,
    result_json->>'channelId', result_json->'message'->>'channelId',
    result_json->'channel'->>'id', result_json->'task'->>'channelId']));

CREATE INDEX CONCURRENTLY idempotency_channel_purge_idx ON data.idempotency_keys USING gin
  ((ARRAY[result_json->>'channelId', result_json->'message'->>'channelId',
    result_json->'channel'->>'id', result_json->'task'->>'channelId']));

CREATE INDEX CONCURRENTLY outbox_channel_purge_idx ON data.outbox USING gin
  ((ARRAY[CASE WHEN aggregate_kind='channel' THEN aggregate_id END,
    payload_json->>'channelId', payload_json->'message'->>'channelId',
    payload_json->'channel'->>'id', payload_json->'task'->>'channelId']));
