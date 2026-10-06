-- A reborn's status is read from its durable intent from the moment it is
-- accepted, keyed by the message that asked for it. The source is the
-- continuation recorded in run_input_json; intents written before it carry
-- none and stay unindexed.
CREATE INDEX agent_reborn_channel_source_idx ON data.agent_reborn_intents
  (channel_id, (run_input_json->'invocationSource'->>'sourceMessageId'))
  WHERE run_input_json ? 'invocationSource';
