import { teamsAppIdentity, teamsReference, teamsRoomId, type TeamsAppIdentity, type TeamsConversationReference } from "./teams-reference.js";
import { sha256Hex } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";

const ROOM = /^spaces\/[A-Za-z0-9_-]{1,128}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const EMAIL = /^[A-Za-z0-9_.-]{1,128}@[a-z0-9-]{4,63}\.iam\.gserviceaccount\.com$/u;
export interface GoogleChatAppIdentity {
  appId: string;
  systemServiceAccountEmail: string;
  serviceAccountEmail: string;
}
export interface GoogleChatRoomBinding {
  connectionId: string;
  spaceId: string;
  chatSpace: string;
  grantGeneration: string;
  connectionGeneration: string;
  confirmedAt: string;
  teamsReference?: TeamsConversationReference;
}
export interface FeishuAppIdentity {
  providerId: "feishu";
  appId: string;
  apiOrigin: "https://open.feishu.cn" | "https://open.larksuite.com";
  eventKeyDigest: string;
}
export type BotRoomBinding = GoogleChatRoomBinding;
export interface TelegramAppIdentity {
  providerId: "telegram";
  botId: string;
  eventKeyDigest: string;
}
type RoomApp = GoogleChatAppIdentity | FeishuAppIdentity | TelegramAppIdentity | TeamsAppIdentity;
type Request = { requestId: string; app: RoomApp };
export function telegramAppIdentity(app: TelegramAppIdentity): string {
  if (app.providerId !== "telegram" || !/^[1-9][0-9]{4,15}$/u.test(app.botId) ||
      !Number.isSafeInteger(Number(app.botId)) || !/^[a-f0-9]{64}$/u.test(app.eventKeyDigest)) {
    throw new AppControlError("invalid_app_request", 400, "Invalid Telegram bot identity");
  }
  return ["telegram", app.botId, app.eventKeyDigest].join("|");
}
export function telegramChatId(value: string): string {
  if (!/^-[1-9][0-9]{0,15}$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new AppControlError("invalid_app_request", 400, "Choose a Telegram group ID");
  }
  return value;
}
export function feishuAppIdentity(app: FeishuAppIdentity): string {
  if (app.providerId !== "feishu" || !/^cli_[A-Za-z0-9]{8,64}$/u.test(app.appId) ||
      !["https://open.feishu.cn", "https://open.larksuite.com"].includes(app.apiOrigin) || !/^[a-f0-9]{64}$/u.test(app.eventKeyDigest)) {
    throw new AppControlError("invalid_app_request", 400, "Invalid Feishu app identity");
  }
  return ["feishu", app.apiOrigin, app.appId, app.eventKeyDigest].join("|");
}
export function googleChatAppIdentity(app: GoogleChatAppIdentity): string {
  if (!/^[1-9][0-9]{0,31}$/u.test(app.appId) || !EMAIL.test(app.serviceAccountEmail) ||
      app.systemServiceAccountEmail !== `service-${app.appId}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`) {
    throw new AppControlError("invalid_app_request", 400, "Invalid Google Chat app identity");
  }
  return [app.appId, app.systemServiceAccountEmail, app.serviceAccountEmail].join("|");
}
function room(value: string, provider = "googlechat"): string {
  if (provider === "teams") {
    if (value === "pending" || /^room-[a-f0-9]{64}$/u.test(value)) return value;
    denied();
  }
  if (provider === "telegram") return telegramChatId(value);
  if (!(provider === "feishu" ? /^[A-Za-z0-9_-]{1,64}\/oc_[A-Za-z0-9]{4,64}$/u : ROOM).test(value)) throw new AppControlError("invalid_app_request", 400, "Invalid Chat room");
  return value;
}
function denied(): never {
  throw new AppControlError("chat_link_invalid", 409, "Chat confirmation expired or changed; start again");
}
function eventTime(value: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new AppControlError("invalid_app_request", 400, "Invalid Chat interaction time");
  }
  return new Date(value).toISOString();
}
async function digest(nonce: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{32}$/u.test(nonce)) denied();
  return sha256Hex(nonce);
}
async function lockRoom(tx: DatabaseTransaction, identity: string, chatSpace: string, provider = "googlechat"): Promise<void> {
  await tx.query({ name: "googlechat_room_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    values: [`${provider}:${identity}:${chatSpace}`], maxRows: 1 });
}
async function admin(tx: DatabaseTransaction, spaceId: string, userId: string): Promise<void> {
  const rows = await tx.query<QueryResultRow>({ name: "googlechat_link_admin_v1", text: `SELECT role
    FROM data.space_members WHERE space_id=$1 AND user_id=$2
      AND NOT EXISTS (SELECT 1 FROM data.space_deletions WHERE space_id=$1)
    LIMIT 1 FOR SHARE`, values: [spaceId, userId], maxRows: 1 });
  if (rows[0]?.role !== "owner" && rows[0]?.role !== "admin") {
    throw new AppControlError("space_not_found", 404, "Space not found");
  }
}
async function snapshot(tx: DatabaseTransaction, connectionId: string, provider = "googlechat") {
  const rows = await tx.query<QueryResultRow>({ name: "bot_room_connection_lock_v2", text: `SELECT
    space_id,version,search_rank_sequence FROM data.app_connector_connections
    WHERE connection_id=$1 AND provider_id=$2 FOR UPDATE`, values: [connectionId, provider], maxRows: 1 });
  if (!rows[0]) denied();
  const credentials = await tx.query<QueryResultRow>({ name: "googlechat_credential_lock_v1", text: `SELECT version
    FROM data.app_connector_credentials WHERE connection_id=$1 FOR UPDATE`, values: [connectionId], maxRows: 1 });
  return { spaceId: String(rows[0].space_id), connectionVersion: Number(rows[0].version),
    credentialVersion: Number(credentials[0]?.version ?? 0), generation: String(rows[0].search_rank_sequence) };
}
function binding(row: QueryResultRow): GoogleChatRoomBinding {
  return { connectionId: String(row.connection_id), spaceId: String(row.space_id), chatSpace: String(row.chat_space),
    grantGeneration: String(row.grant_generation), connectionGeneration: String(row.connection_generation),
    confirmedAt: new Date(row.confirmed_at).toISOString(),
    ...(row.teams_reference ? { teamsReference: row.teams_reference as TeamsConversationReference } : {}) };
}

/** Hub-only app policy authority. Names, user metadata and webhook URLs never bind a room. */
export class PostgresBotRoomRepository {
  private readonly tables: { attempts: string; bindings: string; lifecycle: string };
  constructor(private readonly database: AuthorityDatabase, private readonly provider: "googlechat" | "feishu" | "telegram" | "teams" = "googlechat") {
    if (!["googlechat", "feishu", "telegram", "teams"].includes(provider)) throw new AppControlError("invalid_app_request", 400, "Invalid bot room provider");
    this.tables = provider === "teams" ? { attempts: "app_teams_link_attempts", bindings: "app_teams_room_bindings", lifecycle: "app_teams_room_lifecycle" }
      : provider === "telegram" ? { attempts: "app_telegram_link_attempts", bindings: "app_telegram_room_bindings", lifecycle: "app_telegram_room_lifecycle" }
      : provider === "feishu" ? { attempts: "app_feishu_link_attempts", bindings: "app_feishu_room_bindings", lifecycle: "app_feishu_room_lifecycle" }
      : { attempts: "app_googlechat_link_attempts", bindings: "app_googlechat_room_bindings", lifecycle: "app_googlechat_room_lifecycle" };
    if (database.cacheMode !== "disabled") throw new AppControlError(
      "cached_authority_forbidden", 500, "Chat binding authority requires uncached PostgreSQL");
  }
  private query(name: string) { return `${this.provider}_${name}`; }
  private identity(app: RoomApp) {
    if (this.provider === "teams") {
      if (!("providerId" in app) || app.providerId !== "teams") denied();
      return teamsAppIdentity(app);
    }
    if (this.provider === "telegram") {
      if (!("providerId" in app) || app.providerId !== "telegram") denied();
      return telegramAppIdentity(app);
    }
    if (this.provider === "feishu") {
      if (!("providerId" in app) || app.providerId !== "feishu") denied();
      return feishuAppIdentity(app);
    }
    if ("providerId" in app) denied();
    return googleChatAppIdentity(app);
  }
  private scopeEvidence(alias: "b") {
    return this.provider === "feishu" ? `EXISTS (SELECT 1 FROM data.app_feishu_tenant_lifecycle t
      WHERE t.app_identity=${alias}.app_identity AND t.tenant_key=split_part(${alias}.chat_space,'/',1)
        AND t.active AND ${alias}.confirmed_at>COALESCE(t.retired_at,'-infinity'::timestamptz))` : "true";
  }
  private async scope(tx: DatabaseTransaction, identity: string, chatSpace: string, after?: unknown) {
    if (this.provider !== "feishu") return;
    const rows = await tx.query<QueryResultRow>({ name: this.query("tenant_link_scope_v1"), text: `SELECT 1
      FROM data.app_feishu_tenant_lifecycle WHERE app_identity=$1 AND tenant_key=$2 AND active
        AND (retired_at IS NULL OR retired_at < COALESCE($3::timestamptz,clock_timestamp())) FOR SHARE`,
      values: [identity, chatSpace.split("/")[0], after ?? null], maxRows: 1 });
    if (!rows.length) denied();
  }
  /** Human routes and Check may list the bounded set; every write resolves one exact room again. */
  async list(input: Request & { spaceId: string; forCheck?: boolean }): Promise<BotRoomBinding[]> {
    const identity = this.identity(input.app), spaceId = text(input.spaceId, "spaceId");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: `app.${this.provider}.rooms` }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: this.query("binding_list_v1"), text: `SELECT b.*
        FROM data.${this.tables.bindings} b JOIN data.app_connector_connections c USING(connection_id)
        WHERE b.connection_id=$1 AND b.app_identity=$2 AND b.active AND ${this.scopeEvidence("b")}
          AND b.connection_generation=c.search_rank_sequence AND (c.status='configured' OR ($3 AND c.status='error'))
          AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials v WHERE v.connection_id=b.connection_id)
          AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=b.space_id)
        ORDER BY b.chat_space LIMIT 21`, values: [`${spaceId}:${this.provider}`, identity, !!input.forCheck], maxRows: 21 });
      if (rows.length > 20) denied();
      return rows.map(binding);
    });
  }
  /** Bot membership must first be checked on the provider's fixed API by the caller. */
  async begin(input: Request & { spaceId: string; actorUserId: string; chatSpace: string }) {
    const identity = this.identity(input.app), chatSpace = room(input.chatSpace, this.provider);
    const spaceId = text(input.spaceId, "spaceId"), actor = text(input.actorUserId, "actorUserId");
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
      .replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    const nonceDigest = await digest(nonce);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: `app.${this.provider}.link-begin` }, async tx => {
      await lockRoom(tx, identity, chatSpace, this.provider);
      const current = await snapshot(tx, `${spaceId}:${this.provider}`, this.provider);
      await admin(tx, spaceId, actor);
      await this.scope(tx, identity, chatSpace);
      const owner = await tx.query<QueryResultRow>({ name: this.query("googlechat_link_owner_v1"), text: `SELECT connection_id
        FROM data.${this.tables.bindings} WHERE app_identity=$1 AND chat_space=$2 AND active LIMIT 1`,
      values: [identity, chatSpace], maxRows: 1 });
      if (owner[0] && owner[0].connection_id !== `${spaceId}:${this.provider}`) {
        throw new AppControlError("chat_room_in_use", 409, "Chat room is already connected");
      }
      // Telegram dates have second precision; the random nonce did not exist
      // before this transaction, even when the provider timestamp is rounded.
      const started = this.provider === "telegram" ? "date_trunc('second',statement_timestamp())" : "statement_timestamp()";
      const rows = await tx.query<QueryResultRow>({ name: this.query("googlechat_link_begin_v1"), text: `INSERT INTO
        data.${this.tables.attempts} (connection_id,space_id,app_identity,chat_space,nonce_digest,
          actor_user_id,connection_version,credential_version,connection_generation,started_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${started},${started}+interval '3 minutes')
        ON CONFLICT (connection_id) DO UPDATE SET app_identity=EXCLUDED.app_identity,chat_space=EXCLUDED.chat_space,
          nonce_digest=EXCLUDED.nonce_digest,actor_user_id=EXCLUDED.actor_user_id,connection_version=EXCLUDED.connection_version,
          credential_version=EXCLUDED.credential_version,connection_generation=EXCLUDED.connection_generation,
          started_at=EXCLUDED.started_at,expires_at=EXCLUDED.expires_at RETURNING expires_at`,
      values: [`${spaceId}:${this.provider}`, spaceId, identity, chatSpace, nonceDigest, actor, current.connectionVersion,
        current.credentialVersion, current.generation], maxRows: 1 });
      return { nonce, expiresAt: new Date(rows[0]!.expires_at).toISOString(), chatSpace };
    });
  }
  /** The caller supplies only a verified native bot interaction from this exact room. */
  async confirm(input: Request & { chatSpace: string; nonce: string; eventTime: string; teamsReference?: TeamsConversationReference }): Promise<GoogleChatRoomBinding> {
    const identity = this.identity(input.app), chatSpace = room(input.chatSpace, this.provider);
    const nonceDigest = await digest(input.nonce), at = eventTime(input.eventTime);
    const reference = this.provider === "teams" && "providerId" in input.app && input.app.providerId === "teams"
      ? teamsReference(input.teamsReference!, input.app) : undefined;
    if (reference && chatSpace !== await teamsRoomId(reference)) denied();
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: `app.${this.provider}.link-confirm` }, async tx => {
      await lockRoom(tx, identity, chatSpace, this.provider);
      const target = await tx.query<QueryResultRow>({ name: this.query("googlechat_link_confirm_find_v1"), text: `SELECT connection_id
        FROM data.${this.tables.attempts} WHERE app_identity=$1 AND (chat_space=$2${this.provider === "teams" ? " OR chat_space='pending'" : ""}) AND nonce_digest=$3 LIMIT 1`,
      values: [identity, chatSpace, nonceDigest], maxRows: 1 });
      if (!target[0]) denied();
      // Match the ordinary credential writer's connection-before-attempt lock order.
      const current = await snapshot(tx, String(target[0].connection_id), this.provider);
      const rows = await tx.query<QueryResultRow>({ name: this.query("googlechat_link_confirm_lock_v1"), text: `SELECT *
        FROM data.${this.tables.attempts} WHERE app_identity=$1 AND (chat_space=$2${this.provider === "teams" ? " OR chat_space='pending'" : ""}) AND nonce_digest=$3
          AND expires_at>clock_timestamp() AND $4::timestamptz>=started_at
          AND $4::timestamptz<=clock_timestamp()+interval '30 seconds' FOR UPDATE`,
      values: [identity, chatSpace, nonceDigest, at], maxRows: 1 });
      const attempt = rows[0];
      if (!attempt) denied();
      await admin(tx, current.spaceId, String(attempt.actor_user_id));
      await this.scope(tx, identity, chatSpace, attempt.started_at);
      if (!["googlechat", "teams"].includes(this.provider)) {
        const count = await tx.query<QueryResultRow>({ name: this.query("room_count_v1"), text: `SELECT count(*) AS n
          FROM data.${this.tables.bindings} b WHERE b.connection_id=$1 AND b.active AND b.chat_space<>$2
            AND b.connection_generation=$3 AND ${this.scopeEvidence("b")}`,
          values: [attempt.connection_id, chatSpace, current.generation], maxRows: 1 });
        if (Number(count[0]?.n) >= 20) throw new AppControlError("chat_room_limit", 409, "At most 20 groups can be linked to a Space");
      }
      if (current.connectionVersion !== Number(attempt.connection_version) ||
          current.credentialVersion !== Number(attempt.credential_version) ||
          current.generation !== String(attempt.connection_generation)) denied();
      const removal = await tx.query<QueryResultRow>({ name: this.query("googlechat_link_removal_fence_v1"), text: `SELECT removed_at
        FROM data.${this.tables.lifecycle} WHERE app_identity=$1 AND chat_space=$2
          AND removed_at >= $3::timestamptz LIMIT 1`, values: [identity, chatSpace, attempt.started_at], maxRows: 1 });
      if (removal[0]) denied();
      const owner = await tx.query<QueryResultRow>({ name: this.query("googlechat_confirm_owner_v1"), text: `SELECT connection_id
        FROM data.${this.tables.bindings} WHERE app_identity=$1 AND chat_space=$2 AND active LIMIT 1`,
      values: [identity, chatSpace], maxRows: 1 });
      if (owner[0] && owner[0].connection_id !== attempt.connection_id) denied();
      await tx.query({ name: this.query("googlechat_manual_clear_v1"), text: "DELETE FROM data.app_connector_credentials WHERE connection_id=$1",
        values: [attempt.connection_id], maxRows: 0 });
      const saved = await tx.query<QueryResultRow>({ name: this.query("googlechat_bind_v1"), text: `INSERT INTO
        data.${this.tables.bindings} (connection_id,space_id,app_identity,chat_space,connection_generation,confirmed_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (${!["googlechat", "teams"].includes(this.provider) ? "connection_id,chat_space" : "connection_id"}) DO UPDATE SET app_identity=EXCLUDED.app_identity,
          chat_space=EXCLUDED.chat_space,grant_generation=gen_random_uuid(),connection_generation=EXCLUDED.connection_generation,
          confirmed_at=EXCLUDED.confirmed_at,active=true RETURNING *`,
      values: [attempt.connection_id, current.spaceId, identity, chatSpace, current.generation, at], maxRows: 1 });
      if (reference) {
        await tx.query({ name: "teams_reference_save_v1", text: `UPDATE data.app_teams_room_bindings
          SET teams_reference=$2::jsonb,started_at=$3::timestamptz WHERE connection_id=$1`,
          values: [attempt.connection_id, JSON.stringify(reference), attempt.started_at], maxRows: 0 });
        saved[0]!.teams_reference = reference;
      }
      await tx.query({ name: this.query("googlechat_bind_activate_v1"), text: `UPDATE data.app_connector_connections
        SET status='configured',error=NULL,version=version+1,last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE connection_id=$1`, values: [attempt.connection_id], maxRows: 0 });
      await tx.query({ name: this.query("googlechat_link_consume_v1"), text: `DELETE FROM data.${this.tables.attempts} WHERE connection_id=$1`,
        values: [attempt.connection_id], maxRows: 0 });
      return binding(saved[0]!);
    });
  }
  async pending(input: Request & { spaceId: string }): Promise<boolean> {
    const identity = this.identity(input.app);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: `app.${this.provider}.pending` }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: this.query("link_pending_v1"), text: `SELECT 1 FROM data.${this.tables.attempts}
        WHERE connection_id=$1 AND app_identity=$2 AND expires_at>clock_timestamp() LIMIT 1`,
        values: [`${text(input.spaceId, "spaceId")}:${this.provider}`, identity], maxRows: 1 });
      return rows.length === 1;
    });
  }
  async resolve(input: Request & { spaceId: string; forCheck?: boolean; chatSpace?: string }): Promise<GoogleChatRoomBinding | null> {
    const identity = this.identity(input.app), spaceId = text(input.spaceId, "spaceId");
    if (!["googlechat", "teams"].includes(this.provider) && !input.chatSpace) denied();
    const selected = input.chatSpace ? room(input.chatSpace, this.provider) : null;
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: `app.${this.provider}.resolve` }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: this.query("binding_resolve_v2"), text: `SELECT b.*,
        c.status,c.search_rank_sequence,EXISTS (SELECT 1 FROM data.app_connector_credentials v
          WHERE v.connection_id=b.connection_id) AS manual_credentials,
        EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=b.space_id) AS deleted,
        ${this.provider === "feishu" ? this.scopeEvidence("b") : "true"} AS scope_active
        FROM data.${this.tables.bindings} b JOIN data.app_connector_connections c USING(connection_id)
        WHERE b.connection_id=$1 AND ($2::text IS NULL OR b.chat_space=$2) LIMIT 1`, values: [`${spaceId}:${this.provider}`, selected], maxRows: 1 });
      const row = rows[0];
      if (!row) return null;
      if (row.app_identity !== identity) throw new AppControlError("chat_app_changed", 503, "Chat app changed; reconnect");
      if (!row.active || !row.scope_active || row.deleted || row.manual_credentials || row.search_rank_sequence !== row.connection_generation ||
          (row.status !== "configured" && !(input.forCheck && row.status === "error"))) {
        throw new AppControlError("chat_binding_inactive", 409, "Chat connection is inactive; reconnect");
      }
      return binding(row);
    });
  }
  async unlink(input: Request & { spaceId: string; actorUserId: string; chatSpace: string }): Promise<void> {
    if (this.provider === "googlechat") throw new AppControlError("invalid_app_request", 400, "This provider requires its native removal flow");
    const identity = this.identity(input.app), chatSpace = room(input.chatSpace, this.provider);
    const spaceId = text(input.spaceId, "spaceId"), connectionId = `${spaceId}:${this.provider}`;
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: `app.${this.provider}.unlink` }, async tx => {
      await snapshot(tx, connectionId, this.provider);
      await admin(tx, spaceId, text(input.actorUserId, "actorUserId"));
      await tx.query({ name: this.query("unlink_binding_v1"), text: `DELETE FROM data.${this.tables.bindings}
        WHERE connection_id=$1 AND app_identity=$2 AND chat_space=$3`, values: [connectionId, identity, chatSpace], maxRows: 0 });
      await tx.query({ name: this.query("unlink_attempt_v1"), text: `DELETE FROM data.${this.tables.attempts}
        WHERE connection_id=$1 AND app_identity=$2 AND chat_space=$3`, values: [connectionId, identity, chatSpace], maxRows: 0 });
      await tx.query({ name: this.query("unlink_status_v1"), text: `UPDATE data.app_connector_connections SET
        status=CASE WHEN EXISTS (SELECT 1 FROM data.${this.tables.bindings} b WHERE b.connection_id=$1 AND b.active
          AND b.connection_generation=data.app_connector_connections.search_rank_sequence AND ${this.scopeEvidence("b")})
          THEN status ELSE 'disconnected' END,version=version+1,updated_at=clock_timestamp() WHERE connection_id=$1`,
        values: [connectionId], maxRows: 0 });
    });
  }
  /** Authenticated removal invalidates the exact room; delayed replays cannot retire newer grants. */
  async remove(input: Request & { chatSpace: string; eventTime: string }): Promise<void> {
    const identity = this.identity(input.app), chatSpace = room(input.chatSpace, this.provider), at = eventTime(input.eventTime);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: `app.${this.provider}.room-remove` }, async tx => {
      await lockRoom(tx, identity, chatSpace, this.provider);
      const known = await tx.query<QueryResultRow>({ name: this.query("googlechat_remove_known_v1"), text: `SELECT connection_id
        FROM data.${this.tables.bindings} WHERE app_identity=$1 AND chat_space=$2
        UNION SELECT connection_id FROM data.${this.tables.attempts} WHERE app_identity=$1 AND chat_space=$2 LIMIT 101`,
      values: [identity, chatSpace], maxRows: 101 });
      if (known.length > 100) throw new AppControlError("chat_route_overflow", 503, "Chat room removal exceeded its bound");
      if (!known.length && this.provider !== "teams") return;
      const fresh = await tx.query<QueryResultRow>({ name: this.query("googlechat_remove_time_v1"), text: `SELECT 1
        WHERE $1::timestamptz>=clock_timestamp()-interval '10 minutes'
          AND $1::timestamptz<=clock_timestamp()+interval '30 seconds'`, values: [at], maxRows: 1 });
      if (!fresh.length) return;
      await tx.query({ name: this.query("googlechat_remove_lifecycle_v1"), text: `INSERT INTO data.${this.tables.lifecycle}
        (app_identity,chat_space,removed_at) VALUES ($1,$2,$3) ON CONFLICT (app_identity,chat_space)
        DO UPDATE SET removed_at=GREATEST(data.${this.tables.lifecycle}.removed_at,EXCLUDED.removed_at)`,
      values: [identity, chatSpace, at], maxRows: 0 });
      for (const row of known) {
        await snapshot(tx, String(row.connection_id), this.provider);
        const retired = await tx.query<QueryResultRow>({ name: this.query("googlechat_remove_binding_v1"), text: `UPDATE
          data.${this.tables.bindings} SET active=false WHERE connection_id=$1 AND app_identity=$2
            AND chat_space=$3 AND active AND ${this.provider === "teams" ? "started_at" : "confirmed_at"} <= $4::timestamptz RETURNING connection_id`,
        values: [row.connection_id, identity, chatSpace, at], maxRows: 1 });
        if (retired.length) await tx.query({ name: this.query("googlechat_remove_connection_v1"), text: `UPDATE data.app_connector_connections
          SET status=CASE WHEN EXISTS (SELECT 1 FROM data.${this.tables.bindings} b WHERE b.connection_id=$1 AND b.active)
          THEN status ELSE 'disconnected' END,version=version+1,updated_at=clock_timestamp() WHERE connection_id=$1`,
        values: [row.connection_id], maxRows: 0 });
        await tx.query({ name: this.query("googlechat_remove_attempt_v1"), text: `DELETE FROM data.${this.tables.attempts}
          WHERE connection_id=$1 AND app_identity=$2 AND chat_space=$3 AND started_at <= $4::timestamptz`,
        values: [row.connection_id, identity, chatSpace, at], maxRows: 0 });
      }
    });
  }
  async route(input: Request & { chatSpace: string; eventTime: string }): Promise<GoogleChatRoomBinding | null> {
    const identity = this.identity(input.app), chatSpace = room(input.chatSpace, this.provider), at = eventTime(input.eventTime);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: `app.${this.provider}.route` }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: this.query("googlechat_binding_route_v1"), text: `SELECT b.*
        FROM data.${this.tables.bindings} b JOIN data.app_connector_connections c USING(connection_id)
        WHERE b.app_identity=$1 AND b.chat_space=$2 AND b.active AND c.status='configured'
          AND b.connection_generation=c.search_rank_sequence AND b.confirmed_at <= $3::timestamptz
          AND $3::timestamptz>=clock_timestamp()-interval '10 minutes'
          AND $3::timestamptz<=clock_timestamp()+interval '30 seconds'
          AND ${this.scopeEvidence("b")}
          AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials v WHERE v.connection_id=b.connection_id)
          AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=b.space_id) LIMIT 1`,
      values: [identity, chatSpace, at], maxRows: 1 });
      return rows[0] ? binding(rows[0]) : null;
    });
  }
  async current(input: Request & { binding: GoogleChatRoomBinding }): Promise<boolean> {
    if (!UUID.test(input.binding.grantGeneration)) return false;
    try {
      const live = await this.resolve({ ...input, spaceId: input.binding.spaceId, chatSpace: input.binding.chatSpace });
      return !!live && live.connectionId === input.binding.connectionId && live.chatSpace === input.binding.chatSpace &&
        live.grantGeneration === input.binding.grantGeneration && live.connectionGeneration === input.binding.connectionGeneration;
    } catch (error) {
      if (error instanceof AppControlError && error.status !== 503) return false;
      throw error;
    }
  }
  /** Expired challenges and removal fences have no authority after their replay horizon. */
  async cleanup(input: { requestId: string; limit?: number }): Promise<void> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new AppControlError("invalid_app_request", 400, "Invalid Chat maintenance bound");
    }
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: `app.${this.provider}.cleanup` }, async tx => {
      await tx.query({ name: this.query("googlechat_expired_attempts_v1"), text: `DELETE FROM data.${this.tables.attempts}
        WHERE connection_id IN (SELECT connection_id FROM data.${this.tables.attempts}
          WHERE expires_at < clock_timestamp() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
      values: [limit], maxRows: 0 });
      // One day comfortably exceeds both the three-minute challenge and ten-minute signed-event windows.
      // Retired bindings remain inactive; maintenance never changes a connection or resurrects a grant.
      await tx.query({ name: this.query("googlechat_expired_removals_v1"), text: `DELETE FROM data.${this.tables.lifecycle}
        WHERE (app_identity,chat_space) IN (SELECT app_identity,chat_space FROM data.${this.tables.lifecycle}
          WHERE removed_at < clock_timestamp()-interval '1 day' ORDER BY removed_at LIMIT $1 FOR UPDATE SKIP LOCKED)`,
      values: [limit], maxRows: 0 });
    });
  }
}

/** Bounded compatibility facade for the already-deployed Google Chat room authority. */
export class PostgresGoogleChatRoomRepository extends PostgresBotRoomRepository {
  constructor(database: AuthorityDatabase) { super(database, "googlechat"); }
}
export class PostgresFeishuRoomRepository extends PostgresBotRoomRepository {
  constructor(database: AuthorityDatabase) { super(database, "feishu"); }
}
export class PostgresTelegramRoomRepository extends PostgresBotRoomRepository {
  constructor(database: AuthorityDatabase) { super(database, "telegram"); }
}

export class PostgresTeamsRoomRepository extends PostgresBotRoomRepository {
  constructor(database: AuthorityDatabase) { super(database, "teams"); }
}
