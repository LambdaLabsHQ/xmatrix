-- Suite-ticket company consent. Company ids, selected application and members stay encrypted.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.app_dingtalk_company_attempts (
  state_digest TEXT PRIMARY KEY CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  connection_id TEXT NOT NULL UNIQUE REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL CHECK (connection_id=space_id || ':dingtalk'),
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  actor_user_id TEXT NOT NULL,
  actor_membership_generation TEXT NOT NULL CHECK (length(actor_membership_generation) BETWEEN 1 AND 200),
  connection_version BIGINT NOT NULL CHECK (connection_version>0),
  credential_version BIGINT NOT NULL CHECK (credential_version>=0),
  connection_generation TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'started' CHECK (phase IN ('started','taken','verified')),
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json)='object'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()+interval '10 minutes'
);
CREATE INDEX app_dingtalk_attempt_expiry_idx ON data.app_dingtalk_company_attempts(expires_at);
CREATE INDEX app_dingtalk_attempt_company_idx ON data.app_dingtalk_company_attempts(app_identity,company_digest);
CREATE TABLE data.app_dingtalk_company_grants (
  connection_id TEXT PRIMARY KEY REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL CHECK (connection_id=space_id || ':dingtalk'),
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  actor_user_id TEXT NOT NULL,
  actor_membership_generation TEXT NOT NULL CHECK (length(actor_membership_generation) BETWEEN 1 AND 200),
  connection_generation TEXT NOT NULL,
  grant_generation UUID NOT NULL DEFAULT gen_random_uuid(),
  version BIGINT NOT NULL CHECK (version>0),
  visibility_version BIGINT NOT NULL CHECK (visibility_version>0),
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json)='object'),
  started_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX app_dingtalk_grant_company_idx ON data.app_dingtalk_company_grants(app_identity,company_digest);
CREATE TABLE data.app_dingtalk_company_fences (
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  changed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(app_identity,company_digest)
);
CREATE INDEX app_dingtalk_fence_expiry_idx ON data.app_dingtalk_company_fences(changed_at);
CREATE TABLE data.app_dingtalk_company_visibility (
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  app_id BIGINT NOT NULL CHECK (app_id>0),
  version BIGINT NOT NULL CHECK (version>0),
  event_time TIMESTAMPTZ NOT NULL,
  event_digest TEXT NOT NULL CHECK (event_digest ~ '^[a-f0-9]{64}$'),
  ambiguous BOOLEAN NOT NULL DEFAULT false,
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json)='object'),
  PRIMARY KEY(app_identity,company_digest,app_id)
);
-- Fixed suite-ticket token audiences. This cache never grants a Space/member capability.
CREATE TABLE data.app_dingtalk_company_tokens (
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  token_kind TEXT NOT NULL CHECK (token_kind IN ('suite','corp')),
  ticket_version BIGINT NOT NULL CHECK (ticket_version>0),
  token_generation UUID NOT NULL,
  expires_epoch BIGINT NOT NULL DEFAULT 0 CHECK (expires_epoch>=0),
  encrypted_value_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(encrypted_value_json)='object'),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CHECK ((lease_id IS NULL)=(lease_until IS NULL)),
  PRIMARY KEY(app_identity,company_digest,token_kind)
);
CREATE INDEX app_dingtalk_token_expiry_idx ON data.app_dingtalk_company_tokens(expires_epoch);
