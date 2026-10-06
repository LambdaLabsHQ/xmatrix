-- The App policy authority binds a successful OAuth grant to its provider
-- workspace. Client metadata never supplies this route. Token writes and
-- bindings share one transaction and credential version; no legacy backfill
-- guesses an installation from an old token. Existing installs reconnect.
SET LOCAL lock_timeout = '5s';

CREATE TABLE data.app_connector_oauth_installations (
  connection_id TEXT PRIMARY KEY REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('slack','linear')),
  app_client_id TEXT NOT NULL CHECK (length(app_client_id) BETWEEN 1 AND 256),
  installation_id TEXT NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 128),
  credential_version BIGINT NOT NULL CHECK (credential_version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (connection_id = space_id || ':' || provider_id)
);

CREATE INDEX app_connector_oauth_installation_route_idx ON data.app_connector_oauth_installations
  (provider_id,app_client_id,installation_id,connection_id);
