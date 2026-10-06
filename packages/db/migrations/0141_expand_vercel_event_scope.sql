-- Vercel installations authorize selected projects inside a team or personal
-- account. Preserve both identities; never infer old bindings from metadata.
-- Existing Slack/Linear writers may continue omitting the new nullable column.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.app_connector_oauth_installations ADD COLUMN event_scope_id TEXT;
ALTER TABLE data.app_connector_oauth_installations
  DROP CONSTRAINT app_connector_oauth_installations_provider_id_check,
  ADD CONSTRAINT app_connector_oauth_installations_provider_id_check CHECK (
    (provider_id IN ('slack','linear') AND event_scope_id IS NULL) OR
    (provider_id='vercel' AND installation_id ~ '^icfg_[A-Za-z0-9]{1,80}$'
      AND event_scope_id IS NOT NULL AND event_scope_id ~ '^(team|user)_[A-Za-z0-9_-]{1,80}$')
  ) NOT VALID;
ALTER TABLE data.app_connector_oauth_installations
  VALIDATE CONSTRAINT app_connector_oauth_installations_provider_id_check;
CREATE INDEX app_connector_vercel_scope_route_idx ON data.app_connector_oauth_installations
  (app_client_id,event_scope_id,connection_id) WHERE provider_id='vercel';
