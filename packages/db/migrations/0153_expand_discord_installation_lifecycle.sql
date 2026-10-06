-- Native Discord lifecycle extends provider-confirmed OAuth bindings only.
-- Existing company installs have no trustworthy authorization start/user route:
-- reconnect them; never backfill identities from mutable metadata or ciphertext.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.app_connector_oauth_installations ADD COLUMN discord_authorized_at TIMESTAMPTZ;
ALTER TABLE data.app_connector_oauth_installations
  DROP CONSTRAINT app_connector_oauth_installations_provider_id_check,
  ADD CONSTRAINT app_connector_oauth_installations_provider_id_check CHECK (
    (provider_id IN ('slack','linear') AND event_scope_id IS NULL) OR
    (provider_id='vercel' AND installation_id ~ '^icfg_[A-Za-z0-9]{1,80}$'
      AND event_scope_id IS NOT NULL AND event_scope_id ~ '^(team|user)_[A-Za-z0-9_-]{1,80}$') OR
    (provider_id='sentry' AND installation_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      AND event_scope_id IS NOT NULL AND event_scope_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') OR
    (provider_id='discord' AND app_client_id ~ '^[1-9][0-9]{14,24}$'
      AND installation_id ~ '^[1-9][0-9]{14,24}$' AND event_scope_id IS NOT NULL
      AND event_scope_id ~ '^[1-9][0-9]{14,24}$' AND discord_authorized_at IS NOT NULL)
  ) NOT VALID;
ALTER TABLE data.app_connector_oauth_installations
  VALIDATE CONSTRAINT app_connector_oauth_installations_provider_id_check;
CREATE INDEX app_discord_user_installation_idx ON data.app_connector_oauth_installations
  (app_client_id,event_scope_id,connection_id) WHERE provider_id='discord';

-- One short-lived revocation watermark per application/user fences callbacks
-- that started before deauthorization. Contains neither tokens nor payloads.
CREATE TABLE data.app_discord_revocations (
  app_client_id TEXT NOT NULL CHECK (app_client_id ~ '^[1-9][0-9]{14,24}$'),
  user_id TEXT NOT NULL CHECK (user_id ~ '^[1-9][0-9]{14,24}$'),
  revoked_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (app_client_id,user_id)
);
CREATE INDEX app_discord_revocation_expiry_idx ON data.app_discord_revocations (app_client_id,expires_at,user_id);
