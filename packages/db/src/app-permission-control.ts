import type { QueryResultRow } from "pg";
import { connectorPermission, type ConnectorPermission } from "@xmatrix/protocol";
import type { AuthorityDatabase } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";

function storedPermission(rows: readonly QueryResultRow[]): ConnectorPermission | null {
  if (!rows[0]) throw new AppControlError("app_connection_not_found", 404, "App connection not found");
  return connectorPermission(rows[0].permission_mode) ?? null;
}

/** One uncached, server-owned permission on the Space's connection. */
export class PostgresAppPermissionRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new AppControlError("cached_authority_forbidden", 500, "App permission requires uncached PostgreSQL");
  }

  async read(input: { requestId: string; spaceId: string; providerId: string; actorUserId: string }): Promise<ConnectorPermission | null> {
    const spaceId = text(input.spaceId, "spaceId"), actorUserId = text(input.actorUserId, "actorUserId");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.permission.read" }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_permission_member_read_v1", text: `SELECT c.permission_mode
        FROM data.app_connector_connections c JOIN data.space_members m ON m.space_id=c.space_id
        WHERE c.space_id=$1 AND c.provider_id=$2 AND m.user_id=$3 LIMIT 1`,
      values: [spaceId, text(input.providerId, "providerId", 80), actorUserId], maxRows: 1 });
      return storedPermission(rows);
    });
  }

  async set(input: { requestId: string; spaceId: string; providerId: string; mode: ConnectorPermission | null; actorUserId: string; at: string }) {
    const spaceId = text(input.spaceId, "spaceId"), actorUserId = text(input.actorUserId, "actorUserId");
    if (input.mode !== null && !connectorPermission(input.mode)) throw new AppControlError("invalid_app_request", 400, "mode is read, ask, write or null");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.permission.set" }, async tx => {
      const role = await tx.query<QueryResultRow>({ name: "app_permission_admin_v1", text: `SELECT role FROM data.space_members
        WHERE space_id=$1 AND user_id=$2 LIMIT 1`, values: [spaceId, actorUserId], maxRows: 1 });
      if (!["owner", "admin"].includes(String(role[0]?.role))) throw new AppControlError("space_not_found", 404, "Space not found");
      const rows = await tx.query<QueryResultRow>({ name: "app_permission_set_v1", text: `UPDATE data.app_connector_connections
        SET permission_mode=$3,version=version+1,updated_at=$4 WHERE space_id=$1 AND provider_id=$2 RETURNING connection_id`,
      values: [spaceId, text(input.providerId, "providerId", 80), input.mode, new Date(input.at).toISOString()], maxRows: 1 });
      if (!rows[0]) throw new AppControlError("app_connection_not_found", 404, "App connection not found");
      return { mode: input.mode };
    });
  }

  /** Execution already proves current Run/connection access and reads this uncached immediately before I/O. */
  async mode(input: { requestId: string; connectionId: string }): Promise<ConnectorPermission | null> {
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.permission.execute" }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_permission_execute_v1", text: `SELECT permission_mode
        FROM data.app_connector_connections WHERE connection_id=$1 LIMIT 1`, values: [text(input.connectionId, "connectionId")], maxRows: 1 });
      return storedPermission(rows);
    });
  }
}
