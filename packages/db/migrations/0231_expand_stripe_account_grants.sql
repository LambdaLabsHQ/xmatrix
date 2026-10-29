-- Stripe grants belong to individual merchant accounts, independently of the
-- Space's single Stripe connection. Move the existing authenticated binding
-- and its envelope intact; do not infer an account from caller metadata.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.app_stripe_account_grants (
  connection_id TEXT NOT NULL REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  account_id TEXT NOT NULL CHECK (account_id ~ '^acct_[A-Za-z0-9]{1,64}$'),
  app_client_id TEXT NOT NULL CHECK (app_client_id ~ '^ca_[A-Za-z0-9]+$'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  grant_generation UUID NOT NULL,
  authorized_at TIMESTAMPTZ NOT NULL,
  connected_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','reconnect')),
  credential_version BIGINT NOT NULL CHECK (credential_version>=1),
  -- Only migrated envelopes retain their former authenticated encryption owner.
  envelope_kind TEXT NOT NULL CHECK (envelope_kind IN ('connection','account')),
  legacy_pending BOOLEAN NOT NULL DEFAULT false,
  encrypted_value_json JSONB,
  expires_at TIMESTAMPTZ,
  refresh_lease UUID,
  refresh_started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (connection_id,account_id),
  CHECK (connection_id=space_id||':stripe'),
  CHECK ((refresh_lease IS NULL)=(refresh_started_at IS NULL)),
  CHECK (status<>'active' OR encrypted_value_json IS NOT NULL)
);
CREATE INDEX app_stripe_account_route_idx ON data.app_stripe_account_grants
  (app_client_id,account_id,connection_id);
INSERT INTO data.app_stripe_account_grants
  (connection_id,space_id,account_id,app_client_id,display_name,grant_generation,
   authorized_at,connected_by,status,credential_version,envelope_kind,encrypted_value_json,updated_at,legacy_pending)
SELECT i.connection_id,i.space_id,i.installation_id,i.app_client_id,i.installation_id,
  COALESCE(i.grant_generation,gen_random_uuid()),i.updated_at,c.created_by,
  CASE WHEN c.status='disconnected' THEN 'reconnect' ELSE 'active' END,
  k.version,'connection',k.encrypted_value_json,i.updated_at,true
FROM data.app_connector_oauth_installations i
JOIN data.app_connector_connections c ON c.connection_id=i.connection_id AND c.space_id=i.space_id AND c.provider_id='stripe'
JOIN data.app_connector_credentials k ON k.connection_id=i.connection_id AND k.space_id=i.space_id AND k.version=i.credential_version
WHERE i.provider_id='stripe';
-- The new Hub adopts a pending connection under its parent lock, validates the
-- encrypted account identity, then atomically retires the exact legacy writer.
-- Old Hub instances keep their original store until that per-connection cutover.
