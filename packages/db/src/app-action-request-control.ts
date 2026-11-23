import type { QueryResultRow } from "pg";
import { isXDurableAction, utf8ByteLength, X_DURABLE_ACTIONS } from "@xmatrix/protocol";
import { requireChannelCapability } from "./channel-capability-policy.js";
import { AppControlError } from "./app-control.js";
import { appCredentialValueLimit } from "./app-credential-control.js";
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

/** The X actions only the durable executor dispatches, as SQL. */
const X_DURABLE_ACTIONS_SQL = `(${X_DURABLE_ACTIONS.map(action => `'${action}'`).join(",")})`;
/**
 * The requests the durable executor runs: an X video action, and any action a
 * Norn program performs (docs/architecture/norn-host.md "Asking a connected
 * app"). Its outcome is kept until whoever asked has been told.
 */
const DURABLE_SQL = `((provider_id='x' AND action_id IN ${X_DURABLE_ACTIONS_SQL}) OR norn_perform_ref IS NOT NULL)`;
/** How long an action a program prepared can still be approved, and then performed. */
const HELD_INTERVAL = "30 days";

export interface XUploadReference { requestId: string; spaceId: string; channelId: string }
export interface XExecutingUpload {
  request: ReturnType<typeof view> & { connectionId: string };
  payload: AppActionRequestPayload;
}
export interface XUploadOutcome {
  request: XExecutingUpload["request"];
  payload: Pick<AppActionRequestPayload, "messageId" | "senderKind" | "senderId">;
  receipt: string;
  status: "completed" | "failed" | "blocked";
  /** What a completed action gave back, for a program that reads it as its answer. */
  result?: { summary: string; url?: string };
}

function uploadOutcomeValue(value: unknown, status: unknown): Omit<XUploadOutcome, "request"> {
  const invalid = () => new AppControlError("action_request_outcome_invalid", 409, "Upload outcome is invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const outcome = value as Record<string, unknown>;
  if (outcome.status !== status || !["completed", "failed", "blocked"].includes(String(status)) ||
      typeof outcome.receipt !== "string" || !outcome.receipt.trim() ||
      !outcome.payload || typeof outcome.payload !== "object" || Array.isArray(outcome.payload)) throw invalid();
  const payload = outcome.payload as Record<string, unknown>;
  const identifier = (field: unknown): field is string => typeof field === "string" && !!field.trim() && utf8ByteLength(field) <= 300;
  if (!identifier(payload.messageId) || (payload.senderKind !== "user" && payload.senderKind !== "agent") ||
      (payload.senderId !== undefined && !identifier(payload.senderId))) throw invalid();
  const result = outcome.result as Record<string, unknown> | undefined;
  if (result !== undefined && (!result || typeof result !== "object" || Array.isArray(result) || typeof result.summary !== "string" ||
      (result.url !== undefined && typeof result.url !== "string"))) throw invalid();
  return { receipt: outcome.receipt, status: status as XUploadOutcome["status"], payload: {
    messageId: payload.messageId, senderKind: payload.senderKind,
    ...(payload.senderId !== undefined ? { senderId: payload.senderId } : {}),
  }, ...(result ? { result: { summary: String(result.summary), ...(typeof result.url === "string" ? { url: result.url } : {}) } } : {}) };
}

function view(row: QueryResultRow) {
  return { requestId: String(row.request_id), channelId: String(row.channel_id), spaceId: String(row.space_id),
    providerId: String(row.provider_id), actionId: String(row.action_id), requestedBy: String(row.requested_by),
    status: String(row.status), expiresAt: new Date(row.expires_at as string).toISOString(),
    /** The program's `prepare` request this serves, and the `perform` that runs it, by their references. */
    nornPrepareRef: typeof row.norn_prepare_ref === "string" ? row.norn_prepare_ref : null,
    nornPerformRef: typeof row.norn_perform_ref === "string" ? row.norn_perform_ref : null };
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

  private async snapshot(tx: DatabaseTransaction, connectionId: string, channelId: string, actorUserId: string) {
    const channel = await requireChannelCapability(tx, { channelId, principal: { kind: "user", id: actorUserId },
      capability: "app_new_work", error: failure => new AppControlError(failure.code, failure.status, failure.message) });
    const rows = await tx.query<QueryResultRow>({ name: "app_action_request_scope_v2", text: `SELECT
      c.space_id,c.provider_id,c.search_rank_sequence AS generation,coalesce(k.version,0) AS credential_version,
      k.encrypted_value_json
      FROM data.app_connector_connections c
      LEFT JOIN data.app_connector_credentials k ON k.connection_id=c.connection_id
      WHERE c.connection_id=$1 AND c.space_id=$2 AND c.status='configured'
        AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=c.space_id)
      LIMIT 1 FOR SHARE OF c`, values: [connectionId, channel.spaceId], maxRows: 1 });
    if (!rows[0]) throw new AppControlError("action_request_scope_changed", 409, "Action approval access changed");
    return rows[0];
  }

  private async decrypt(row: QueryResultRow): Promise<AppActionRequestPayload> {
    return JSON.parse(await decryptSecretValue(this.material, { encrypted_value_json: row.encrypted_value_json,
      owner_user_id: `app-action-request:${row.request_id}`, secret_ref: "input", authority_version: 1 }));
  }

  /** Token rotation changes the envelope, while approval belongs to one immutable X grant. */
  private async requireXAccount(scope: QueryResultRow, connectionId: string, requestedBy: string,
    payload: AppActionRequestPayload) {
    const changed = () => new AppControlError("action_request_scope_changed", 409, "Connected account changed; ask again");
    const id = /^[1-9][0-9]{0,19}$/u;
    const generation = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
    const prepared = payload?.prepared;
    if (!prepared || typeof prepared !== "object" || Array.isArray(prepared) ||
        typeof prepared.accountId !== "string" || !id.test(prepared.accountId) ||
        typeof prepared.accountGeneration !== "string" || !generation.test(prepared.accountGeneration) ||
        !Number.isSafeInteger(Number(scope.credential_version)) || Number(scope.credential_version) < 1 ||
        !scope.encrypted_value_json) throw changed();
    try {
      const envelope = JSON.parse(await decryptSecretValue(this.material, {
        encrypted_value_json: scope.encrypted_value_json, owner_user_id: `app-connection:${connectionId}`,
        secret_ref: "credentials", authority_version: Number(scope.credential_version),
      })) as Record<string, unknown> | null;
      const serialized = envelope?.accounts;
      if (typeof serialized !== "string" || utf8ByteLength(serialized) > appCredentialValueLimit("x", "accounts")) throw changed();
      const accounts: unknown = JSON.parse(serialized);
      if (!Array.isArray(accounts)) throw changed();
      const ids = new Set<string>();
      let matches = 0;
      for (const account of accounts) {
        if (!account || typeof account !== "object" || Array.isArray(account) ||
            typeof account.id !== "string" || !id.test(account.id) || ids.has(account.id) ||
            typeof account.generation !== "string" || !generation.test(account.generation) ||
            typeof account.ownerUserId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(account.ownerUserId)) throw changed();
        ids.add(account.id);
        if (account.id === prepared.accountId && account.generation === prepared.accountGeneration &&
            account.ownerUserId === requestedBy) matches += 1;
      }
      if (matches !== 1) throw changed();
    } catch {
      throw changed();
    }
  }

  private async requireApprovedGrant(scope: QueryResultRow, row: QueryResultRow, payload?: AppActionRequestPayload) {
    const perAccount = row.provider_id === "x" && row.action_id !== "accounts";
    if (scope.generation !== row.connection_generation || scope.provider_id !== row.provider_id ||
        (!perAccount && Number(scope.credential_version) !== Number(row.credential_version))) {
      throw new AppControlError("action_request_scope_changed", 409, "Connected account changed; ask again");
    }
    if (perAccount) {
      await this.requireXAccount(scope, String(row.connection_id), String(row.requested_by), payload ?? await this.decrypt(row));
    }
  }

  private async requireUploadAllow(tx: DatabaseTransaction, row: QueryResultRow) {
    if (!isXDurableAction(String(row.provider_id), String(row.action_id))) {
      throw new AppControlError("action_request_scope_changed", 409, "This request cannot start an allowed upload");
    }
    const policies = await tx.query<QueryResultRow>({ name: "app_action_request_upload_write_v1", text: `SELECT permission_mode
      FROM data.app_connector_connections WHERE connection_id=$1 AND space_id=$2
        AND permission_mode='write' LIMIT 1 FOR SHARE`,
    values: [row.connection_id, row.space_id], maxRows: 1 });
    if (!policies[0]) throw new AppControlError("action_request_forbidden", 403, "This upload requires Read and write permission");
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
    actionId: string; requestedBy: string; payload: AppActionRequestPayload;
    /** The Norn program's `prepare` request this serves: approving it runs nothing until the program performs it. */
    heldFor?: string }) {
    const requestId = text(input.requestId, "requestId", 240);
    if (utf8ByteLength(JSON.stringify(input.payload)) > 64 * 1024) {
      throw new AppControlError("invalid_app_request", 400, "Action approval input is too large");
    }
    const envelope = await encryptSecretValue(this.material, `app-action-request:${requestId}`, "input", 1,
      JSON.stringify(input.payload));
    return this.transaction("create", async tx => {
      const scope = await this.snapshot(tx, input.connectionId, input.channelId, input.requestedBy);
      if (scope.provider_id !== input.providerId) {
        throw new AppControlError("action_request_scope_changed", 409, "Action approval provider changed");
      }
      if (input.providerId === "x" && input.actionId !== "accounts") {
        await this.requireXAccount(scope, input.connectionId, input.requestedBy, input.payload);
      }
      // Bounded expiry maintenance piggybacks on new requests, preserving outcome evidence.
      await tx.query({ name: "app_action_request_expire_v1", text: `UPDATE data.app_connector_action_requests
        SET encrypted_value_json=NULL,status=CASE WHEN status='pending' THEN 'expired' ELSE status END,updated_at=now()
        WHERE request_id IN (SELECT request_id FROM data.app_connector_action_requests
          WHERE space_id=$1 AND expires_at<=now() AND encrypted_value_json IS NOT NULL ORDER BY expires_at LIMIT 50)`,
      values: [scope.space_id], maxRows: 0 });
      await tx.query({ name: "app_action_request_insert_v2", text: `INSERT INTO data.app_connector_action_requests
        (request_id,space_id,channel_id,connection_id,provider_id,action_id,requested_by,connection_generation,
         credential_version,encrypted_value_json,status,created_at,expires_at,updated_at,norn_prepare_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'pending',now(),
          now()+CASE WHEN $11::text IS NULL THEN interval '24 hours' ELSE interval '${HELD_INTERVAL}' END,now(),$11)
        ON CONFLICT (request_id) DO NOTHING`, values: [requestId, scope.space_id, input.channelId, input.connectionId,
      input.providerId, input.actionId, input.requestedBy, scope.generation, scope.credential_version,
      JSON.stringify(envelope), input.heldFor ?? null], maxRows: 0 });
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_created_v1", text:
        "SELECT * FROM data.app_connector_action_requests WHERE request_id=$1 LIMIT 1", values: [requestId], maxRows: 1 });
      const row = rows[0]!;
      if (row.connection_id !== input.connectionId || row.channel_id !== input.channelId || row.requested_by !== input.requestedBy ||
        row.action_id !== input.actionId || row.provider_id !== input.providerId || (row.norn_prepare_ref ?? null) !== (input.heldFor ?? null)) {
        throw new AppControlError("action_request_conflict", 409, "Action approval identity changed");
      }
      if (row.status === "pending" && JSON.stringify(await this.decrypt(row)) !== JSON.stringify(input.payload)) {
        throw new AppControlError("action_request_conflict", 409, "Action approval content changed");
      }
      return view(row);
    });
  }

  /** Only current Space admins receive the sensitive preview or may decide. Hub also checks Channel read access. */
  private async requireAdmin(tx: DatabaseTransaction, spaceId: string, actorUserId: string, channelId: string) {
    const rows = await tx.query<QueryResultRow>({ name: "app_action_request_admin_v1", text: `SELECT role
      FROM data.space_members WHERE space_id=$1 AND user_id=$2 LIMIT 1 FOR SHARE`,
    values: [spaceId, actorUserId], maxRows: 1 });
    if (rows[0]?.role !== "owner" && rows[0]?.role !== "admin") {
      throw new AppControlError("action_request_forbidden", 403, "A Space admin answers action approvals");
    }
    await requireChannelCapability(tx, { channelId, spaceId, principal: { kind: "user", id: actorUserId },
      capability: "app_history_read", error: failure => new AppControlError(failure.code, failure.status, failure.message) });
  }

  async pending(input: { channelId: string; spaceId: string; actorUserId: string }) {
    return this.transaction("pending", async tx => {
      await this.requireAdmin(tx, input.spaceId, input.actorUserId, input.channelId);
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_pending_v1", text: `SELECT *
        FROM data.app_connector_action_requests WHERE channel_id=$1 AND space_id=$2 AND status='pending'
          AND expires_at>now() ORDER BY created_at LIMIT 50`, values: [input.channelId, input.spaceId], maxRows: 50 });
      return Promise.all(rows.map(async row => ({ ...view(row), preview: (await this.decrypt(row)).preview })));
    });
  }

  /** A durable executing marker precedes provider I/O. Replayed or concurrent approvals never dispatch again. */
  async decide(input: { requestId: string; channelId: string; spaceId: string; actorUserId: string; allow: boolean }) {
    return this.transaction("decide", async tx => {
      await this.requireAdmin(tx, input.spaceId, input.actorUserId, input.channelId);
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_decide_v1", text: `SELECT *
        FROM data.app_connector_action_requests WHERE request_id=$1 AND channel_id=$2 AND space_id=$3 LIMIT 1`,
      values: [input.requestId, input.channelId, input.spaceId], maxRows: 1 });
      const row = rows[0];
      if (!row) throw new AppControlError("action_request_not_found", 404, "Action approval not found");
      if (row.status !== "pending") return { request: view(row), claimed: false as const };
      if (input.allow && new Date(row.expires_at as string).getTime() <= Date.now()) {
        throw new AppControlError("action_request_expired", 409, "Action approval expired; ask again");
      }
      const scope = input.allow ? await this.snapshot(tx, String(row.connection_id), input.channelId, String(row.requested_by)) : undefined;
      const xPayload = input.allow && row.provider_id === "x" ? await this.decrypt(row) : undefined;
      if (scope) await this.requireApprovedGrant(scope, row, xPayload);
      const locked = await tx.query<QueryResultRow>({ name: "app_action_request_claim_lock_v1", text: `SELECT *
        FROM data.app_connector_action_requests WHERE request_id=$1 AND channel_id=$2 AND space_id=$3 FOR UPDATE`,
      values: [input.requestId, input.channelId, input.spaceId], maxRows: 1 });
      if (!locked[0]) throw new AppControlError("action_request_not_found", 404, "Action approval not found");
      if (locked[0].status !== "pending") return { request: view(locked[0]), claimed: false as const };
      const payload = input.allow ? xPayload ?? await this.decrypt(row) : undefined;
      // A program's request is approved here and run when the program performs it: this decision dispatches nothing.
      const held = row.norn_prepare_ref !== null && row.norn_prepare_ref !== undefined;
      const status = !input.allow ? "denied" : held ? "approved" : "executing";
      await tx.query({ name: "app_action_request_claim_v1", text: `UPDATE data.app_connector_action_requests
        SET status=$2,decided_by=$3,updated_at=now(),encrypted_value_json=CASE WHEN $2='denied' THEN NULL ELSE encrypted_value_json END
        WHERE request_id=$1 AND status='pending'`, values: [input.requestId, status, input.actorUserId], maxRows: 0 });
      if (held) return { request: { ...view(row), status }, claimed: false as const };
      return { request: { ...view(row), status }, claimed: input.allow, payload };
    });
  }

  /** Explicit allow consumes one staged upload without impersonating a Human approver. */
  async startAllowed(input: XUploadReference & { actorUserId: string }) {
    return this.transaction("start-allowed-upload", async tx => {
      await requireChannelCapability(tx, { channelId: input.channelId, spaceId: input.spaceId,
        principal: { kind: "user", id: input.actorUserId }, capability: "app_new_work",
        error: failure => new AppControlError(failure.code, failure.status, failure.message) });
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_upload_start_read_v2", text: `SELECT *
        FROM data.app_connector_action_requests WHERE request_id=$1 AND space_id=$2 AND channel_id=$3
          AND requested_by=$4 AND provider_id='x' AND action_id IN ${X_DURABLE_ACTIONS_SQL} LIMIT 1`,
      values: [input.requestId, input.spaceId, input.channelId, input.actorUserId], maxRows: 1 });
      const row = rows[0];
      if (!row) throw new AppControlError("action_request_not_found", 404, "Upload request not found");
      if (row.status !== "pending") return { request: { ...view(row), connectionId: String(row.connection_id) }, claimed: false as const };
      if (new Date(row.expires_at as string).getTime() <= Date.now()) {
        throw new AppControlError("action_request_expired", 409, "Upload request expired");
      }
      const scope = await this.snapshot(tx, String(row.connection_id), input.channelId, input.actorUserId);
      const payload = await this.decrypt(row);
      await this.requireApprovedGrant(scope, row, payload);
      await this.requireUploadAllow(tx, row);
      const locked = await tx.query<QueryResultRow>({ name: "app_action_request_upload_start_lock_v1", text: `SELECT *
        FROM data.app_connector_action_requests WHERE request_id=$1 AND space_id=$2 AND channel_id=$3 FOR UPDATE`,
      values: [input.requestId, input.spaceId, input.channelId], maxRows: 1 });
      if (!locked[0]) throw new AppControlError("action_request_not_found", 404, "Upload request not found");
      if (locked[0].status !== "pending") return { request: { ...view(locked[0]), connectionId: String(locked[0].connection_id) }, claimed: false as const };
      await tx.query({ name: "app_action_request_upload_start_v1", text: `UPDATE data.app_connector_action_requests
        SET status='executing',decided_by=NULL,updated_at=now() WHERE request_id=$1 AND status='pending'`,
      values: [input.requestId], maxRows: 0 });
      return { request: { ...view(row), connectionId: String(row.connection_id), status: "executing" }, claimed: true as const, payload };
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
      if (row.decided_by !== null) await this.requireAdmin(tx, String(row.space_id), String(row.decided_by), channelId);
      const scope = await this.snapshot(tx, connectionId, channelId, String(row.requested_by));
      await this.requireApprovedGrant(scope, row);
      const held = typeof row.norn_prepare_ref === "string";
      if (row.decided_by === null && !held) await this.requireUploadAllow(tx, row);
      // Nobody decided a program's request that the connection's permission admitted: the caller reads that permission again.
      return { decidedByPerson: row.decided_by !== null };
    });
  }

  /**
   * A program's request the connection's permission admits without a person
   * (the Hub read that permission): it is approved, and runs when the program
   * performs it.
   */
  async admitHeld(input: { requestId: string; spaceId: string; channelId: string }) {
    return this.transaction("admit-held", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_admit_held_v1", text: `UPDATE
        data.app_connector_action_requests SET status='approved',decided_by=NULL,updated_at=now()
        WHERE request_id=$1 AND space_id=$2 AND channel_id=$3 AND norn_prepare_ref IS NOT NULL AND status='pending'
          AND expires_at>now() RETURNING *`, values: [input.requestId, input.spaceId, input.channelId], maxRows: 1 });
      return rows[0] ? view(rows[0]) : null;
    });
  }

  /** How the action request of a program's `prepare` stands, by that request's reference. */
  async heldRequest(input: { spaceId: string; prepareRef: string }) {
    return this.transaction("held-request", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_held_v1", text: `SELECT *,(expires_at<=now()) AS lapsed
        FROM data.app_connector_action_requests WHERE space_id=$1 AND norn_prepare_ref=$2 LIMIT 1`,
      values: [input.spaceId, input.prepareRef], maxRows: 1 });
      return rows[0] ? { ...view(rows[0]), lapsed: rows[0].lapsed === true, decidedBy: rows[0].decided_by === null ? null : String(rows[0].decided_by) } : null;
    });
  }

  /**
   * A program performs what was admitted: the one step from approved to
   * executing, taken once. What was approved is checked again as a decision
   * checks it: the approver is still an admin who reads the conversation, and
   * the connection and its account are the ones approved. Returns why it
   * cannot run instead; a repeat by the same `perform` finds its own claim.
   */
  async claimHeld(input: { spaceId: string; channelId: string; prepareRef: string; performRef: string }) {
    return this.transaction("claim-held", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_claim_held_lock_v1", text: `SELECT *,(expires_at<=now()) AS lapsed
        FROM data.app_connector_action_requests WHERE space_id=$1 AND channel_id=$2 AND norn_prepare_ref=$3 FOR UPDATE`,
      values: [input.spaceId, input.channelId, input.prepareRef], maxRows: 1 });
      const row = rows[0];
      if (!row) return { refusal: "What was prepared is not known in this conversation" };
      if (row.norn_perform_ref === input.performRef && row.status === "executing") return { request: view(row) };
      if (row.norn_perform_ref !== null) return { refusal: "It was performed before; a prepared action is performed once" };
      if (row.status !== "approved") return { refusal: `It is ${String(row.status)}, not approved` };
      if (row.lapsed === true) return { refusal: "Its approval is older than 30 days; prepare it again" };
      if (row.decided_by !== null) await this.requireAdmin(tx, input.spaceId, String(row.decided_by), input.channelId);
      const scope = await this.snapshot(tx, String(row.connection_id), input.channelId, String(row.requested_by));
      await this.requireApprovedGrant(scope, row);
      await tx.query({ name: "app_action_request_claim_held_v1", text: `UPDATE data.app_connector_action_requests
        SET status='executing',norn_perform_ref=$2,updated_at=now() WHERE request_id=$1 AND status='approved'`,
      values: [row.request_id, input.performRef], maxRows: 0 });
      return { request: { ...view(row), status: "executing", nornPerformRef: input.performRef } };
    });
  }

  /**
   * Programs no longer ask for these: an approval nobody answered is taken
   * back, and with `approved` one that was given and never used is void. The
   * frozen input goes with it.
   */
  async withdrawHeld(input: { spaceId: string; prepareRefs: string[]; approved?: boolean }): Promise<string[]> {
    if (!input.prepareRefs.length) return [];
    return this.transaction("withdraw-held", async tx => (await tx.query<QueryResultRow>({ name: "app_action_request_withdraw_held_v1",
      text: `UPDATE data.app_connector_action_requests SET status='expired',encrypted_value_json=NULL,updated_at=now()
        WHERE space_id=$1 AND norn_prepare_ref=ANY($2::text[]) AND (status='pending' OR ($3 AND status='approved'))
        RETURNING channel_id`, values: [input.spaceId, input.prepareRefs, input.approved === true], maxRows: 1_000 }))
      .map(row => String(row.channel_id)));
  }

  /** Server-only recovery input; the durable scheduler stores this reference, never the payload. */
  async executingUpload(input: XUploadReference): Promise<XExecutingUpload | null> {
    return this.transaction("executing-upload", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_executing_upload_v3", text: `SELECT *
        FROM data.app_connector_action_requests WHERE request_id=$1 AND space_id=$2 AND channel_id=$3
          AND ${DURABLE_SQL} AND status='executing' AND expires_at>now()
        LIMIT 1 FOR SHARE`, values: [input.requestId, input.spaceId, input.channelId], maxRows: 1 });
      const row = rows[0];
      return row ? { request: { ...view(row), connectionId: String(row.connection_id) }, payload: await this.decrypt(row) } : null;
    });
  }

  /** Persist one bounded encrypted receipt before attempting its Channel append. */
  async settleUpload(input: XUploadReference & { status: XUploadOutcome["status"]; receipt: string;
    result?: XUploadOutcome["result"] }): Promise<{ stored: boolean }> {
    if (!["completed", "failed", "blocked"].includes(input.status) || typeof input.receipt !== "string" ||
        !input.receipt.trim() || utf8ByteLength(input.receipt) > 64 * 1024) {
      throw new AppControlError("invalid_app_request", 400, "Upload receipt is invalid");
    }
    return this.transaction("settle-upload", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_upload_settle_lock_v3", text: `SELECT *
        FROM data.app_connector_action_requests WHERE request_id=$1 AND space_id=$2 AND channel_id=$3
          AND ${DURABLE_SQL} AND status='executing' AND expires_at>now() FOR UPDATE`,
      values: [input.requestId, input.spaceId, input.channelId], maxRows: 1 });
      const row = rows[0];
      if (!row) return { stored: false };
      const payload = await this.decrypt(row);
      const outcome = uploadOutcomeValue({ status: input.status, receipt: input.receipt,
        payload: { messageId: payload.messageId, senderKind: payload.senderKind, senderId: payload.senderId },
        ...(input.result ? { result: input.result } : {}) }, input.status);
      const plaintext = JSON.stringify(outcome);
      if (utf8ByteLength(plaintext) > 64 * 1024) throw new AppControlError("invalid_app_request", 400, "Upload outcome is too large");
      const envelope = await encryptSecretValue(this.material, `app-action-request:${input.requestId}`, "outcome", 1, plaintext);
      await tx.query({ name: "app_action_request_upload_settle_v1", text: `UPDATE data.app_connector_action_requests
        SET status=$2,updated_at=now(),encrypted_value_json=$3::jsonb WHERE request_id=$1 AND status='executing'`,
      values: [input.requestId, input.status, JSON.stringify(envelope)], maxRows: 0 });
      return { stored: true };
    });
  }

  async uploadOutcome(input: XUploadReference): Promise<XUploadOutcome | null> {
    return this.transaction("upload-outcome", async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_action_request_upload_outcome_v3", text: `SELECT *
        FROM data.app_connector_action_requests WHERE request_id=$1 AND space_id=$2 AND channel_id=$3
          AND ${DURABLE_SQL} AND status IN ('completed','failed','blocked')
          AND encrypted_value_json IS NOT NULL AND expires_at>now() LIMIT 1 FOR SHARE`,
      values: [input.requestId, input.spaceId, input.channelId], maxRows: 1 });
      const row = rows[0];
      if (!row) return null;
      const plaintext = await decryptSecretValue(this.material, { encrypted_value_json: row.encrypted_value_json,
        owner_user_id: `app-action-request:${row.request_id}`, secret_ref: "outcome", authority_version: 1 });
      if (utf8ByteLength(plaintext) > 64 * 1024) throw new AppControlError("action_request_outcome_invalid", 409, "Upload outcome is too large");
      let parsed: unknown;
      try { parsed = JSON.parse(plaintext); } catch { throw new AppControlError("action_request_outcome_invalid", 409, "Upload outcome is invalid"); }
      const outcome = uploadOutcomeValue(parsed, row.status);
      return { request: { ...view(row), connectionId: String(row.connection_id) }, ...outcome };
    });
  }

  /** Called only after the trusted publisher confirms this receipt's Channel append. */
  async clearUploadOutcome(input: XUploadReference): Promise<void> {
    await this.transaction("clear-upload-outcome", tx => tx.query({ name: "app_action_request_upload_outcome_clear_v3", text: `UPDATE
      data.app_connector_action_requests SET encrypted_value_json=NULL,updated_at=now()
      WHERE request_id=$1 AND space_id=$2 AND channel_id=$3 AND ${DURABLE_SQL}
        AND status IN ('completed','failed','blocked')`, values: [input.requestId, input.spaceId, input.channelId], maxRows: 0 }));
  }

  async settle(requestId: string, status: "completed" | "failed" | "blocked") {
    return this.transaction("settle", async tx => {
      await tx.query({ name: "app_action_request_settle_v1", text: `UPDATE data.app_connector_action_requests
        SET status=$2,updated_at=now(),encrypted_value_json=NULL WHERE request_id=$1 AND status='executing'`,
      values: [requestId, status], maxRows: 0 });
    });
  }
}
