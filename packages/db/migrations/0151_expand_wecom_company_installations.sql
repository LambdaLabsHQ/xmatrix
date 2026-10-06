-- Private Human-confirmed company grants; provider ids and permanent codes are encrypted.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.app_wecom_install_attempts (
  state_digest TEXT PRIMARY KEY CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  connection_id TEXT NOT NULL UNIQUE REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  actor_user_id TEXT NOT NULL,
  connection_version BIGINT NOT NULL CHECK (connection_version >= 1),
  credential_version BIGINT NOT NULL CHECK (credential_version >= 0),
  connection_generation TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'started' CHECK (phase IN ('started','exchanged','prepared')),
  encrypted_value_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(encrypted_value_json)='object'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()+interval '10 minutes',
  CHECK (connection_id=space_id || ':wecom')
);
CREATE INDEX app_wecom_install_attempt_expiry_idx ON data.app_wecom_install_attempts(expires_at);
CREATE INDEX app_wecom_install_attempt_company_idx ON data.app_wecom_install_attempts(app_identity,company_digest) WHERE company_digest IS NOT NULL;
CREATE TABLE data.app_wecom_installations (
  connection_id TEXT PRIMARY KEY REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  grant_generation UUID NOT NULL DEFAULT gen_random_uuid(),
  connection_generation TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json)='object'),
  started_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK (connection_id=space_id || ':wecom')
);
CREATE INDEX app_wecom_company_lookup_idx ON data.app_wecom_installations(app_identity,company_digest);
CREATE TABLE data.app_wecom_company_lifecycle (
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  changed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (app_identity,company_digest)
);
CREATE TABLE data.app_wecom_suite_tokens (
  app_identity TEXT PRIMARY KEY CHECK (length(app_identity) BETWEEN 1 AND 600),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  encrypted_value_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(encrypted_value_json)='object'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  CHECK ((lease_id IS NULL)=(lease_until IS NULL))
);
CREATE INDEX app_wecom_company_lifecycle_expiry_idx ON data.app_wecom_company_lifecycle(changed_at);
