-- Stripe App installations are the connected account. Several Spaces may bind
-- the same account. Existing paste connections have no installation row.
SET LOCAL lock_timeout = '5s';
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
      AND event_scope_id ~ '^[1-9][0-9]{14,24}$' AND discord_authorized_at IS NOT NULL) OR
    (provider_id='stripe' AND installation_id ~ '^acct_[A-Za-z0-9]{1,64}$' AND event_scope_id IS NULL)
  ) NOT VALID;
ALTER TABLE data.app_connector_oauth_installations
  VALIDATE CONSTRAINT app_connector_oauth_installations_provider_id_check;
