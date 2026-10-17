import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import type { AppOAuthInstallation } from "./app-credential-control.js";

/** A Slack workspace connected here is already another Space's. */
export const SLACK_WORKSPACE_TAKEN = "workspace_connected_elsewhere";

/**
 * A Slack workspace speaks for one Space. Slack issues one bot per workspace,
 * and its events carry whatever channels that bot was invited into, so a
 * second Space bound to the same workspace would read the first Space's
 * private channels. The Space whose binding is current keeps the workspace
 * until it disconnects or Slack retires the installation (app uninstalled);
 * a later Connect elsewhere is refused. Serialized per workspace before any
 * connection or credential lock, so two concurrent Connects cannot both bind.
 */
export async function claimSlackWorkspace(tx: DatabaseTransaction, installation: AppOAuthInstallation,
  connectionId: string): Promise<void> {
  await tx.query({ name: "slack_workspace_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    values: [`slack:${installation.appClientId}:${installation.installationId}`], maxRows: 1 });
  const held = await tx.query<QueryResultRow>({ name: "slack_workspace_claim_v1", text: `SELECT i.connection_id
    FROM data.app_connector_oauth_installations i
    JOIN data.app_connector_connections c ON c.connection_id=i.connection_id AND c.space_id=i.space_id
      AND c.provider_id=i.provider_id AND c.status='configured'
    JOIN data.app_connector_credentials k ON k.connection_id=i.connection_id AND k.space_id=i.space_id
      AND k.version=i.credential_version
    WHERE i.provider_id='slack' AND i.app_client_id=$1 AND i.installation_id=$2 AND i.connection_id<>$3
      AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=i.space_id)
    LIMIT 1`, values: [installation.appClientId, installation.installationId, connectionId], maxRows: 1 });
  if (held[0]) {
    throw new AppControlError(SLACK_WORKSPACE_TAKEN, 409,
      "This Slack workspace is already connected to another xMatrix Space");
  }
}
