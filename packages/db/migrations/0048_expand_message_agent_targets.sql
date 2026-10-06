-- Original existing-instance mention targets are resolved by Message authority
-- at publication, never reconstructed from a later mutable Profile name.
ALTER TABLE data.messages ADD COLUMN agent_invocation_targets_json JSONB;
ALTER TABLE data.messages ADD CONSTRAINT message_agent_targets_bounded CHECK (
  agent_invocation_targets_json IS NULL OR
  (jsonb_typeof(agent_invocation_targets_json)='object' AND pg_column_size(agent_invocation_targets_json)<=1048576)
) NOT VALID;
