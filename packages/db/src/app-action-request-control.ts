import type { QueryResultRow } from "pg";
import { utf8ByteLength } from "@xmatrix/protocol";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";
import { decryptSecretValue, encryptSecretValue } from "./secret-value-control.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";

/** Immutable, encrypted action input. A decision consumes exactly one request. */
export interface AppActionRequestPayload {
  messageId: string;
  senderKind: "user" | "agent";
  senderId?: string;
  statement: { target: string; text: string };
  prepared: Record<string, string>;
  preview: Record<string, string>;
}

function view(row: QueryResultRow) {
  return { requestId: String(row.request_id), channelId: String(row.channel_id), spaceId: String(row.space_id),
    providerId: String(row.provider_id), actionId: String(row.action_id), requestedBy: String(row.requested_by),
    status: String(row.status), expiresAt: new Date(row.expires_at as string).toISOString() };
}

export class PostgresAppActionRequestRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {
    if (database.cacheMode !== "disabled" || !material) {
      throw new AppControlError("action_request_unavailable", 503, "Action approval authority is unavailable");
    }
  }

  private transaction<T>(operation: string, run: (tx: DatabaseTransaction) => Promise<T>) {
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: `app.action-request.${operation}` }, run);
  }

  private async snapshot(tx: DatabaseTransaction, connectionId: string, channelId: string) {
    const rows = await tx.query<QueryResultRow>({ name: "app_action_request_scope_v1", text: `SELECT
      c.space_id,c.search_rank_sequence AS generation,coalesce(k.version,0) AS credential_version
      FROM data.app_connector_connections c JOIN data.channels h ON h.space_id=c.space_id AND h.channel_id=$2
      LEFT JOIN data.app_connector_credentials k ON k.connection_id=c.connection_id
      WHERE c.connection_id=$1 AND c.status='configured'
        AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=c.space_id)
      LIMIT 1 FOR SHARE OF c,h`, values: [connectionId, channelId], maxRows: 1 });
    if (!rows[0]) throw new AppControlError("action_request_scope_changed", 409, "Action approval access changed");
    return rows[0];
  }

  private async decrypt(row: QueryResultRow): Promise<AppActionRequestPayload> {
    return JSON.parse(await decryptSecretValue(this.material, { encrypted_value_json: row.encrypted_value_json,
      owner_user_id: `app-action-request:${row.request_id}`, secret_ref: "input", authority_version: 1 }));
  }

  /** Re-delivery of a staged call never becomes an immediate send after a policy change. */
  async find(requestId: string, connectionId: string, channelId: string, requestedBy: string) {
    return this.transaction("find", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_find_v1", text: `SELECT
        request_id,channel_id,space_id,provider_id,action_id,requested_by,status,expires_at
        FROM data.app_connector_action_requests WHERE request_id=$1 AND connection_id=$2 AND channel_id=$3
          AND requested_by=$4 LIMIT 1`, values: [requestId, connectionId, channelId, requestedBy], maxRows: 1 });
      return rows[0] ? view(rows[0]) : null;
    });
  }

  async create(input: { requestId: string; connectionId: string; channelId: string; providerId: string;
    actionId: string; requestedBy: string; payload: AppActionRequestPayload }) {
    const requestId = text(input.requestId, "requestId", 240);
    if (utf8ByteLength(JSON.stringify(input.payload)) > 64 * 1024) {
      throw new AppControlError("invalid_app_request", 400, "Action approval input is too large");
    }
    const envelope = await encryptSecretValue(this.material, `app-action-request:${requestId}`, "input", 1,
      JSON.stringify(input.payload));
    return this.transaction("create", async tx => {
      const scope = await this.snapshot(tx, input.connectionId, input.channelId);
      // Bounded expiry maintenance piggybacks on new requests, preserving outcome evidence.
      await tx.query({ name: "app_action_request_expire_v1", text: `UPDATE data.app_connector_action_requests
        SET encrypted_value_json=NULL,status=CASE WHEN status='pending' THEN 'expired' ELSE status END,updated_at=now()
        WHERE request_id IN (SELECT request_id FROM data.app_connector_action_requests
          WHERE space_id=$1 AND expires_at<=now() AND encrypted_value_json IS NOT NULL ORDER BY expires_at LIMIT 50)`,
      values: [scope.space_id], maxRows: 0 });
      await tx.query({ name: "app_action_request_insert_v1", text: `INSERT INTO data.app_connector_action_requests
        (request_id,space_id,channel_id,connection_id,provider_id,action_id,requested_by,connection_generation,
         credential_version,encrypted_value_json,status,created_at,expires_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'pending',now(),now()+interval '24 hours',now())
        ON CONFLICT (request_id) DO NOTHING`, values: [requestId, scope.space_id, input.channelId, input.connectionId,
      input.providerId, input.actionId, input.requestedBy, scope.generation, scope.credential_version,
      JSON.stringify(envelope)], maxRows: 0 });
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_created_v1", text:
        "SELECT * FROM data.app_connector_action_requests WHERE request_id=$1 LIMIT 1", values: [requestId], maxRows: 1 });
      const row = rows[0]!;
      if (row.connection_id !== input.connectionId || row.channel_id !== input.channelId || row.requested_by !== input.requestedBy ||
        row.action_id !== input.actionId || row.provider_id !== input.providerId) {
        throw new AppControlError("action_request_conflict", 409, "Action approval identity changed");
      }
      if (row.status === "pending" && JSON.stringify(await this.decrypt(row)) !== JSON.stringify(input.payload)) {
        throw new AppControlError("action_request_conflict", 409, "Action approval content changed");
      }
      return view(row);
    });
  }

  /** Only current Space admins receive the sensitive preview or may decide. Hub also checks Channel read access. */
  private async requireAdmin(tx: DatabaseTransaction, spaceId: string, actorUserId: string) {
    const rows = await tx.query<QueryResultRow>({ name: "app_action_request_admin_v1", text: `SELECT role
      FROM data.space_members WHERE space_id=$1 AND user_id=$2 LIMIT 1 FOR SHARE`,
    values: [spaceId, actorUserId], maxRows: 1 });
    if (rows[0]?.role !== "owner" && rows[0]?.role !== "admin") {
      throw new AppControlError("action_request_forbidden", 403, "A Space admin answers action approvals");
    }
  }

  async pending(input: { channelId: string; spaceId: string; actorUserId: string }) {
    return this.transaction("pending", async tx => {
      await this.requireAdmin(tx, input.spaceId, input.actorUserId);
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_pending_v1", text: `SELECT *
        FROM data.app_connector_action_requests WHERE channel_id=$1 AND space_id=$2 AND status='pending'
          AND expires_at>now() ORDER BY created_at LIMIT 50`, values: [input.channelId, input.spaceId], maxRows: 50 });
      return Promise.all(rows.map(async row => ({ ...view(row), preview: (await this.decrypt(row)).preview })));
    });
  }

  /** A durable executing marker precedes provider I/O. Replayed or concurrent approvals never dispatch again. */
  async decide(input: { requestId: string; channelId: string; spaceId: string; actorUserId: string; allow: boolean }) {
    return this.transaction("decide", async tx => {
      await this.requireAdmin(tx, input.spaceId, input.actorUserId);
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_decide_v1", text: `SELECT *
        FROM data.app_connector_action_requests WHERE request_id=$1 AND channel_id=$2 AND space_id=$3 FOR UPDATE`,
      values: [input.requestId, input.channelId, input.spaceId], maxRows: 1 });
      const row = rows[0];
      if (!row) throw new AppControlError("action_request_not_found", 404, "Action approval not found");
      if (row.status !== "pending") return { request: view(row), claimed: false as const };
      if (input.allow && new Date(row.expires_at as string).getTime() <= Date.now()) {
        throw new AppControlError("action_request_expired", 409, "Action approval expired; ask again");
      }
      const scope = input.allow ? await this.snapshot(tx, String(row.connection_id), input.channelId) : undefined;
      if (scope && (scope.generation !== row.connection_generation || Number(scope.credential_version) !== Number(row.credential_version))) {
        throw new AppControlError("action_request_scope_changed", 409, "Connected account changed; ask again");
      }
      const payload = input.allow ? await this.decrypt(row) : undefined;
      const status = input.allow ? "executing" : "denied";
      await tx.query({ name: "app_action_request_claim_v1", text: `UPDATE data.app_connector_action_requests
        SET status=$2,decided_by=$3,updated_at=now(),encrypted_value_json=CASE WHEN $2='denied' THEN NULL ELSE encrypted_value_json END
        WHERE request_id=$1 AND status='pending'`, values: [input.requestId, status, input.actorUserId], maxRows: 0 });
      return { request: { ...view(row), status }, claimed: input.allow, payload };
    });
  }

  /** Revalidate the one consumed approval and current account immediately before provider I/O. */
  async authorize(requestId: string, connectionId: string, channelId: string) {
    return this.transaction("authorize", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_authorize_v1", text: `SELECT *
        FROM data.app_connector_action_requests WHERE request_id=$1 AND connection_id=$2 AND channel_id=$3
          AND status='executing' AND expires_at>now() LIMIT 1`, values: [requestId, connectionId, channelId], maxRows: 1 });
      const row = rows[0];
      if (!row) throw new AppControlError("action_request_not_executing", 409, "This approval cannot execute");
      await this.requireAdmin(tx, String(row.space_id), String(row.decided_by));
      const scope = await this.snapshot(tx, connectionId, channelId);
      if (scope.generation !== row.connection_generation || Number(scope.credential_version) !== Number(row.credential_version)) {
        throw new AppControlError("action_request_scope_changed", 409, "Connected account changed; ask again");
      }
    });
  }

  async settle(requestId: string, status: "completed" | "failed" | "blocked") {
    return this.transaction("settle", async tx => {
      await tx.query({ name: "app_action_request_settle_v1", text: `UPDATE data.app_connector_action_requests
        SET status=$2,updated_at=now(),encrypted_value_json=NULL WHERE request_id=$1 AND status='executing'`,
      values: [requestId, status], maxRows: 0 });
    });
  }
}
