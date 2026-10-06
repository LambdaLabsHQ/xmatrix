-- Dormant primary inbound owner. No native transport, proof or public route is enabled.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.app_dingtalk_inbound_attempts (
  state_digest TEXT PRIMARY KEY CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  connection_id TEXT NOT NULL REFERENCES data.app_dingtalk_company_grants(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL CHECK (connection_id=space_id || ':dingtalk'),
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  parent_generation UUID NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_membership_generation TEXT NOT NULL,
  connection_generation TEXT NOT NULL,
  visibility_version BIGINT NOT NULL CHECK (visibility_version>0),
  scope_digest TEXT NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  phase TEXT NOT NULL CHECK (phase IN ('started','taken')),
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json)='object'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()+interval '10 minutes'
);
CREATE INDEX app_dingtalk_inbound_attempt_expiry_idx ON data.app_dingtalk_inbound_attempts(expires_at);
CREATE INDEX app_dingtalk_inbound_attempt_connection_idx ON data.app_dingtalk_inbound_attempts(app_identity,connection_id);
CREATE TABLE data.app_dingtalk_inbound_scopes (
  connection_id TEXT NOT NULL REFERENCES data.app_dingtalk_company_grants(connection_id) ON DELETE CASCADE,
  scope_digest TEXT NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  space_id TEXT NOT NULL CHECK (connection_id=space_id || ':dingtalk'),
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  parent_generation UUID NOT NULL,
  inbound_generation UUID NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_membership_generation TEXT NOT NULL,
  connection_generation TEXT NOT NULL,
  visibility_version BIGINT NOT NULL CHECK (visibility_version>0),
  active BOOLEAN NOT NULL DEFAULT true,
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json)='object'),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(connection_id,scope_digest)
);
CREATE INDEX app_dingtalk_inbound_scope_target_idx ON data.app_dingtalk_inbound_scopes(app_identity,company_digest,scope_digest);
CREATE TABLE data.app_dingtalk_inbound_receipts (
  app_identity TEXT NOT NULL CHECK (length(app_identity) BETWEEN 1 AND 600),
  event_digest TEXT NOT NULL CHECK (event_digest ~ '^[a-f0-9]{64}$'),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  retain_until TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()+interval '7 days',
  PRIMARY KEY(app_identity,event_digest)
);
CREATE INDEX app_dingtalk_inbound_receipt_expiry_idx ON data.app_dingtalk_inbound_receipts(app_identity,retain_until);
CREATE TABLE data.app_dingtalk_inbound_jobs (
  app_identity TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  scope_digest TEXT NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  space_id TEXT NOT NULL CHECK (connection_id=space_id || ':dingtalk'),
  company_digest TEXT NOT NULL CHECK (company_digest ~ '^[a-f0-9]{64}$'),
  parent_generation UUID NOT NULL,
  inbound_generation UUID NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_membership_generation TEXT NOT NULL,
  connection_generation TEXT NOT NULL,
  visibility_version BIGINT NOT NULL CHECK (visibility_version>0),
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  payload_expires_epoch BIGINT NOT NULL CHECK (payload_expires_epoch>0),
  encrypted_value_json JSONB NOT NULL CHECK (jsonb_typeof(encrypted_value_json)='object'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','done','obsolete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  CHECK ((state='leased')=(lease_id IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((lease_id IS NULL)=(lease_until IS NULL)),
  PRIMARY KEY(app_identity,event_digest,connection_id,inbound_generation),
  FOREIGN KEY(app_identity,event_digest) REFERENCES data.app_dingtalk_inbound_receipts ON DELETE CASCADE
);
CREATE INDEX app_dingtalk_inbound_job_due_idx ON data.app_dingtalk_inbound_jobs(app_identity,available_at,lease_until)
  WHERE state IN ('pending','leased');
CREATE INDEX app_dingtalk_inbound_job_connection_idx ON data.app_dingtalk_inbound_jobs(connection_id,app_identity)
  WHERE state IN ('pending','leased');
