-- Which Space a Slack workspace speaks for. Slack issues one bot per app and
-- workspace, and that bot stays in every channel it was invited into until the
-- app is uninstalled from the workspace; disconnecting in xMatrix, a failed
-- check, revoking one token or deleting the Space does not take it out. So the
-- claim outlives the Space's connection, binding and the Space itself, and only
-- Slack's signed app_uninstalled (dated after the claim) releases it.
-- Existing bindings claim their workspace; where bindings made before one
-- Space per workspace share one, the earliest binding keeps it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE data.app_slack_workspace_claims (
  app_client_id TEXT NOT NULL CHECK (length(app_client_id) BETWEEN 1 AND 256),
  installation_id TEXT NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 128),
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  claimed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (app_client_id, installation_id)
);

INSERT INTO data.app_slack_workspace_claims (app_client_id, installation_id, space_id, claimed_at)
SELECT DISTINCT ON (app_client_id, installation_id) app_client_id, installation_id, space_id, updated_at
FROM data.app_connector_oauth_installations
WHERE provider_id = 'slack'
ORDER BY app_client_id, installation_id, updated_at, connection_id;
