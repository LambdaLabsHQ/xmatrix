-- Only launch preparation writes this publication witness. Generic spawn
-- metadata cannot authorize a new source association, including on old rows.
ALTER TABLE data.agent_launches ADD COLUMN initial_source_json JSONB;
ALTER TABLE data.agent_launches ADD CONSTRAINT agent_launch_initial_source_bound
  CHECK (initial_source_json IS NULL OR (jsonb_typeof(initial_source_json)='object' AND pg_column_size(initial_source_json)<=2048)) NOT VALID;
