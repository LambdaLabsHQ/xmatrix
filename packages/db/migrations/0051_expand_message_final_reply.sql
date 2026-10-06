-- Explicit final intent belongs to the committed Message, not runtime presence.
-- Nullable for older writers. Message retention, deletion and shard movement
-- own this column; no independent lifecycle or substitute execution authority.
ALTER TABLE data.messages ADD COLUMN agent_final_reply_json JSONB;
ALTER TABLE data.messages ADD CONSTRAINT message_final_reply_bounded CHECK (
  agent_final_reply_json IS NULL OR
  (jsonb_typeof(agent_final_reply_json)='object' AND pg_column_size(agent_final_reply_json)<=2048)
) NOT VALID;
CREATE INDEX message_final_reply_execution_idx ON data.messages
  (space_id,channel_id,(agent_final_reply_json->>'runId'),
   (agent_final_reply_json->>'executionId'),timeline_sequence DESC)
  WHERE agent_final_reply_json IS NOT NULL
    AND COALESCE(invocation_input_version,entity_version)=1
    AND deleted_at IS NULL AND recalled_at IS NULL;
