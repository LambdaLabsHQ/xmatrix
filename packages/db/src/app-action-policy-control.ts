import type { QueryResultRow } from "pg";

import type { AuthorityDatabase } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";

/*
 * Per-Channel connector action policy (docs/design/connector-platform.md §3.5).
 * A row overrides the manifest default for one action in one Channel: `allow`
 * lets Agents run a write action there, `deny` blocks the action for everyone.
 * Only Space owners and admins write it; executors read it at execution time.
 */

export type AppActionPolicyMode = "allow" | "deny";

export class PostgresAppActionPolicyRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new AppControlError(
      "cached_authority_forbidden", 500, "App action policy requires uncached PostgreSQL");
  }

  /** Sets or (with `mode: null`) clears one Channel's policy for an action. */
  async set(input: { requestId: string; spaceId: string; providerId: string; channelId: string; actionId: string;
    mode: AppActionPolicyMode | null; actorUserId: string; at: string }) {
    const spaceId = text(input.spaceId, "spaceId");
    const providerId = text(input.providerId, "providerId", 80).toLowerCase();
    const channelId = text(input.channelId, "channelId");
    const actionId = text(input.actionId, "actionId", 100).toLowerCase();
    const actorUserId = text(input.actorUserId, "actorUserId");
    if (input.mode !== null && input.mode !== "allow" && input.mode !== "deny") {
      throw new AppControlError("invalid_app_request", 400, "mode is invalid");
    }
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.action-policy.set" }, async (tx) => {
      const role = await tx.query<QueryResultRow>({ name: "app_action_policy_role_v1", text: `SELECT role
        FROM data.space_members WHERE space_id=$1 AND user_id=$2 LIMIT 1`, values: [spaceId, actorUserId], maxRows: 1 });
      if (role[0]?.role !== "owner" && role[0]?.role !== "admin") {
        throw new AppControlError("space_not_found", 404, "Space not found");
      }
      const connectionId = `${spaceId}:${providerId}`;
      const scope = await tx.query<QueryResultRow>({ name: "app_action_policy_scope_v1", text: `SELECT
        (SELECT 1 FROM data.app_connector_connections WHERE connection_id=$1) AS connection,
        (SELECT 1 FROM data.channels WHERE channel_id=$2 AND space_id=$3) AS channel`,
      values: [connectionId, channelId, spaceId], maxRows: 1 });
      if (!scope[0]?.connection) throw new AppControlError("app_connection_not_found", 404, "App connection not found");
      if (!scope[0]?.channel) throw new AppControlError("channel_not_found", 404, "Channel not found");
      if (input.mode === null) {
        await tx.query({ name: "app_action_policy_clear_v1", text: `DELETE FROM data.app_connector_action_policies
          WHERE connection_id=$1 AND channel_id=$2 AND action_id=$3`, values: [connectionId, channelId, actionId], maxRows: 0 });
        return { connectionId, channelId, actionId, mode: null };
      }
      const at = new Date(input.at).toISOString();
      await tx.query({ name: "app_action_policy_upsert_v1", text: `INSERT INTO data.app_connector_action_policies
        (connection_id,channel_id,action_id,space_id,mode,version,updated_by,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,1,$6,$7,$7)
        ON CONFLICT (connection_id,channel_id,action_id) DO UPDATE SET mode=EXCLUDED.mode,
          version=data.app_connector_action_policies.version+1,updated_by=EXCLUDED.updated_by,
          updated_at=EXCLUDED.updated_at`,
      values: [connectionId, channelId, actionId, spaceId, input.mode, actorUserId, at], maxRows: 0 });
      return { connectionId, channelId, actionId, mode: input.mode };
    });
  }

  /** A connection's Channel overrides, for any Space member to see. */
  async list(input: { requestId: string; spaceId: string; providerId: string; actorUserId: string }):
    Promise<Array<{ channelId: string; actionId: string; mode: AppActionPolicyMode; updatedAt: string }>> {
    const spaceId = text(input.spaceId, "spaceId");
    const connectionId = `${spaceId}:${text(input.providerId, "providerId", 80).toLowerCase()}`;
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.action-policy.list" }, async (tx) => {
      const member = await tx.query<QueryResultRow>({ name: "app_action_policy_member_v1", text: `SELECT 1
        FROM data.space_members WHERE space_id=$1 AND user_id=$2 LIMIT 1`,
      values: [spaceId, text(input.actorUserId, "actorUserId")], maxRows: 1 });
      if (!member[0]) throw new AppControlError("space_not_found", 404, "Space not found");
      const rows = await tx.query<QueryResultRow>({ name: "app_action_policy_list_v1", text: `SELECT
        channel_id,action_id,mode,updated_at FROM data.app_connector_action_policies WHERE connection_id=$1
        ORDER BY action_id,channel_id LIMIT 500`, values: [connectionId], maxRows: 500 });
      return rows.map((row) => ({ channelId: String(row.channel_id), actionId: String(row.action_id),
        mode: row.mode === "deny" ? "deny" : "allow", updatedAt: new Date(row.updated_at as string).toISOString() }));
    });
  }

  /** The Channel's override for an action, read by the executor; `null` is the default. */
  async mode(input: { requestId: string; connectionId: string; channelId: string; actionId: string }):
    Promise<AppActionPolicyMode | null> {
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.action-policy.read" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "app_action_policy_read_v1", text: `SELECT mode
        FROM data.app_connector_action_policies WHERE connection_id=$1 AND channel_id=$2 AND action_id=$3 LIMIT 1`,
      values: [text(input.connectionId, "connectionId"), text(input.channelId, "channelId"),
        text(input.actionId, "actionId", 100).toLowerCase()], maxRows: 1 });
      const mode = rows[0]?.mode;
      return mode === "allow" || mode === "deny" ? mode : null;
    });
  }
}
