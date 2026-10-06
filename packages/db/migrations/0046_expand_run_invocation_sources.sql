-- Keep a trusted mention-to-Run binding separate from caller-owned metadata.
-- Null preserves old Runs; reads never guess an association for them.
ALTER TABLE data.runs ADD COLUMN invocation_source_json JSONB
  CHECK (invocation_source_json IS NULL OR (
    jsonb_typeof(invocation_source_json) = 'object'
    AND pg_column_size(invocation_source_json) <= 8192
  ));

CREATE INDEX runtime_invocation_source_page_idx ON data.runs
  (channel_id, (invocation_source_json->>'sourceMessageId'), created_at, run_id)
  WHERE invocation_source_json IS NOT NULL;
