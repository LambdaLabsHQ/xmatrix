-- Primary App authority only. Identity references, never raw webhook or private content.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.app_connector_oauth_installations ADD COLUMN grant_generation UUID;
CREATE TABLE data.app_sentry_event_receipts (
  app_client_id TEXT NOT NULL CHECK (length(app_client_id) BETWEEN 1 AND 256),
  app_uuid UUID NOT NULL,
  installation_uuid UUID NOT NULL,
  delivery_digest TEXT NOT NULL CHECK (delivery_digest ~ '^[a-f0-9]{64}$'),
  identity_json JSONB NOT NULL CHECK (jsonb_typeof(identity_json)='object' AND octet_length(identity_json::text)<=2048),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()+interval '7 days',
  PRIMARY KEY (app_client_id,app_uuid,installation_uuid,delivery_digest)
);
CREATE INDEX app_sentry_event_receipts_expiry_idx ON data.app_sentry_event_receipts(app_client_id,app_uuid,expires_at);
CREATE TABLE data.app_sentry_event_jobs (
  app_client_id TEXT NOT NULL,
  app_uuid UUID NOT NULL,
  installation_uuid UUID NOT NULL,
  delivery_digest TEXT NOT NULL,
  connection_id TEXT NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 300),
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  grant_generation UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','done','obsolete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  available_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (app_client_id,app_uuid,installation_uuid,delivery_digest,connection_id),
  FOREIGN KEY (app_client_id,app_uuid,installation_uuid,delivery_digest)
    REFERENCES data.app_sentry_event_receipts ON DELETE CASCADE,
  CHECK ((state='leased')=(lease_id IS NOT NULL)),
  CHECK ((state='leased')=(lease_until IS NOT NULL))
);
CREATE INDEX app_sentry_event_jobs_due_idx ON data.app_sentry_event_jobs(app_client_id,app_uuid,available_at,lease_until)
  WHERE state IN ('pending','leased');
