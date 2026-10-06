-- A connection's provider credentials (docs/design/connector-platform.md §3.2):
-- API tokens, webhook signing secrets and the per-connection ingress key, as
-- one AES-GCM envelope bound to the connection and its version. Only the Hub's
-- connector executor and event ingress decrypt it; reads expose field names.
-- Deleting the connection or its Space deletes the row.

SET LOCAL lock_timeout = '5s';

CREATE TABLE data.app_connector_credentials (
  connection_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  field_names_json JSONB NOT NULL CHECK (jsonb_typeof(field_names_json) = 'array'
    AND jsonb_array_length(field_names_json) <= 16),
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json) = 'object'),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(connection_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE INDEX app_connector_credentials_space_idx ON data.app_connector_credentials (space_id);
