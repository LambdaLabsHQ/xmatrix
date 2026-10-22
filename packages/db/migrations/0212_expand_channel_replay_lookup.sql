-- Index only Channel identities, never the complete replay body. Native
-- scope/aggregate identities and all four historical JSON locations share one
-- lookup, so an unindexed OR arm cannot force a scan of unrelated receipts.
CREATE INDEX scoped_replays_channel_purge_idx ON control.scoped_control_command_replays USING gin
  ((ARRAY[CASE WHEN scope_kind='channel' THEN scope_id END,
    result_json->>'channelId', result_json->'message'->>'channelId',
    result_json->'channel'->>'id', result_json->'task'->>'channelId']));

CREATE INDEX idempotency_channel_purge_idx ON data.idempotency_keys USING gin
  ((ARRAY[result_json->>'channelId', result_json->'message'->>'channelId',
    result_json->'channel'->>'id', result_json->'task'->>'channelId']));

CREATE INDEX outbox_channel_purge_idx ON data.outbox USING gin
  ((ARRAY[CASE WHEN aggregate_kind='channel' THEN aggregate_id END,
    payload_json->>'channelId', payload_json->'message'->>'channelId',
    payload_json->'channel'->>'id', payload_json->'task'->>'channelId']));
