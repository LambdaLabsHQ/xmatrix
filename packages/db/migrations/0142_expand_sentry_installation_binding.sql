-- Sentry Public Integrations bind their app and installation UUID independently.
-- Preserve Slack/Linear/Vercel readers and writers; no inferred legacy bindings.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.app_connector_oauth_installations
  DROP CONSTRAINT app_connector_oauth_installations_provider_id_check,
  ADD CONSTRAINT app_connector_oauth_installations_provider_id_check CHECK (
    (provider_id IN ('slack','linear') AND event_scope_id IS NULL) OR
    (provider_id='vercel' AND installation_id ~ '^icfg_[A-Za-z0-9]{1,80}$'
      AND event_scope_id IS NOT NULL AND event_scope_id ~ '^(team|user)_[A-Za-z0-9_-]{1,80}$') OR
    (provider_id='sentry' AND installation_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
      AND event_scope_id IS NOT NULL AND event_scope_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
  ) NOT VALID;
ALTER TABLE data.app_connector_oauth_installations
  VALIDATE CONSTRAINT app_connector_oauth_installations_provider_id_check;
