import type { QueryResultRow } from "pg";
import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "@xmatrix/protocol";
import type { DatabaseTransaction } from "./contracts.js";

/** The apps connected to a Space that an Agent can act in, named on every
 * Run's spawn so its launch prompt says they are there
 * (docs/design/connector-platform.md §3.5). Only the names travel: the Agent
 * runs `xmatrix connector list` for their commands when it needs one. */
export async function connectedAppsSpawnFields(tx: DatabaseTransaction, spaceId: string): Promise<{ connectedApps?: string[] }> {
  const rows = await tx.query<QueryResultRow & { provider_id: string }>({
    name: "connected_apps_spawn_v1",
    text: `SELECT provider_id FROM data.app_connector_connections
      WHERE space_id=$1 AND status='configured' ORDER BY provider_id`,
    values: [spaceId], maxRows: APP_CONNECTOR_PROVIDER_MANIFESTS.length });
  const configured = new Set(rows.map((row) => String(row.provider_id)));
  const names = APP_CONNECTOR_PROVIDER_MANIFESTS
    .filter((manifest) => configured.has(manifest.id) && manifest.actions.some((action) => action.effect))
    .map((manifest) => manifest.name);
  return names.length > 0 ? { connectedApps: names } : {};
}
