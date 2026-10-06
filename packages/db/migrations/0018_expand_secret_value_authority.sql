CREATE TABLE data.secret_values (
  owner_user_id TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  authority_ref TEXT NOT NULL UNIQUE,
  authority_version BIGINT NOT NULL CHECK (authority_version >= 1),
  value_digest TEXT NOT NULL,
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  last_command_id TEXT,
  last_command_digest TEXT,
  PRIMARY KEY (owner_user_id, secret_ref),
  CHECK (updated_at >= created_at)
);

CREATE INDEX secret_values_expiry_idx
  ON data.secret_values (expires_at, owner_user_id, secret_ref)
  WHERE expires_at IS NOT NULL;
