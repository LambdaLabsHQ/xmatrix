import type { QueryResultRow } from "pg";
import { commandDigest as digest } from "./command-digest.js";
import { ControlError } from "./control-error.js";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import {
  requireChannelCapability,
  type ChannelCapabilityGrant,
} from "./channel-capability-policy.js";
import { commandFields } from "./command-fields.js";
import { spaceMemberRole } from "./space-members.js";
import { readScopedCommandReplay, storeScopedCommandReplay, COMMAND_REPLAY_TTL_MS as REPLAY_TTL_MS } from "./command-replay.js";


export class AppControlError extends ControlError {
  override name = "AppControlError";
}

/** The App authority's request field readers, shared with the Hub's App policy routes. */
export const appRequestFields = commandFields((field) =>
  new AppControlError("invalid_app_request", 400, `${field} is invalid`));
const { text, object } = appRequestFields;

/** The user or Agent an App request acts for. */
export function appPrincipal(input: Record<string, unknown>): AppPrincipal {
  return appRequestFields.principal(input.principal,
    () => new AppControlError("forbidden", 403, "principal is invalid"));
}
const reusedCommand = () => new AppControlError("idempotency_mismatch", 409, "command id was reused");


function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function array(value: unknown, field: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 200 || value.some((item) =>
    typeof item !== "string" || !item.trim() || item.length > 300)) {
    throw new AppControlError("invalid_app_request", 400, `${field} is invalid`);
  }
  return Array.from(new Set(value.map((item) => String(item).trim()))).sort();
}

const METADATA_LIST_MAX_ITEMS = 32;

/**
 * Adds each `metadataAppend` value to its string-list field, keeping every
 * other field and every value already listed. Runs under the connection's
 * row lock, so concurrent appends (a second org's install) cannot drop each
 * other; an already-listed value is a no-op.
 */
export function appendMetadataLists(metadata: Record<string, unknown>, append: unknown): Record<string, unknown> {
  if (append === undefined) return metadata;
  if (!append || typeof append !== "object" || Array.isArray(append)) {
    throw new AppControlError("invalid_app_request", 400, "metadataAppend is invalid");
  }
  const merged = { ...metadata };
  for (const [field, raw] of Object.entries(append as Record<string, unknown>)) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value || value.length > 300) {
      throw new AppControlError("invalid_app_request", 400, "metadataAppend is invalid");
    }
    const existing = merged[field];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new AppControlError("invalid_app_request", 400, "metadataAppend field is not a list");
    }
    const list = ((existing as unknown[] | undefined) ?? []).filter((item): item is string =>
      typeof item === "string");
    if (list.includes(value)) continue;
    if (list.length >= METADATA_LIST_MAX_ITEMS) {
      throw new AppControlError("invalid_app_request", 400, "metadataAppend list is full");
    }
    merged[field] = [...list, value];
  }
  return merged;
}

function pageCursor(value: unknown, arity: number): string[] | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === arity &&
      parsed.every((item) => typeof item === "string") ? parsed as string[] : null;
  } catch {
    return null;
  }
}

async function requireSpace(tx: DatabaseTransaction, spaceId: string, userId: string, write: boolean) {
  const role = await spaceMemberRole(tx, "app_space_role_v1", spaceId, userId);
  if (!role || (write && role !== "owner" && role !== "admin")) {
    throw new AppControlError("space_not_found", 404, "Space not found");
  }
}

async function appChannelCapability(tx: DatabaseTransaction, channelId: string,
  principal: { kind: "user" | "agent"; id: string },
  capability: "app_history_read" | "app_new_work" | "app_terminalize",
): Promise<ChannelCapabilityGrant> {
  return requireChannelCapability(tx, { channelId, principal, capability,
    error: (failure) => new AppControlError(failure.code, failure.status, failure.message) });
}

/** Subscriptions shown per connection; a batch query reads this many connections at once. */
const RELATIONS_PER_CONNECTION = 500;
const CONNECTIONS_PER_RELATION_QUERY = 20;

type Subscription = { kind: string; source: string; features: unknown; updatedAt: string };

/**
 * A Channel's subscriptions of each connection. One query per batch, not one
 * per connection: queries on a transaction queue behind each other and the
 * client read timeout counts that wait, so a page of connections read one by
 * one timed out on a slow link (XMATRIX-HUB-4S).
 */
async function relationsByConnection(tx: DatabaseTransaction, connectionIds: string[], channelId: string) {
  const byConnection = new Map<string, Subscription[]>();
  for (let start = 0; start < connectionIds.length; start += CONNECTIONS_PER_RELATION_QUERY) {
    const batch = connectionIds.slice(start, start + CONNECTIONS_PER_RELATION_QUERY);
    const rows = await tx.query<QueryResultRow>({ name: "app_connection_relations_v2", text: `SELECT
      connection_id,source_kind,source_ref,features_json,updated_at FROM (SELECT
        connection_id,source_kind,source_ref,features_json,updated_at,row_number() OVER (
          PARTITION BY connection_id ORDER BY source_kind,source_ref) AS position
        FROM data.app_source_relations WHERE connection_id=ANY($1::text[]) AND channel_id=$2) ranked
      WHERE position<=$3 ORDER BY connection_id,source_kind,source_ref`,
    values: [batch, channelId, RELATIONS_PER_CONNECTION], maxRows: batch.length * RELATIONS_PER_CONNECTION });
    for (const row of rows) {
      const id = String(row.connection_id);
      const list = byConnection.get(id) ?? [];
      list.push({ kind: String(row.source_kind), source: String(row.source_ref),
        features: row.features_json, updatedAt: iso(row.updated_at as string | Date) });
      byConnection.set(id, list);
    }
  }
  return byConnection;
}

async function credentialFieldsByConnection(tx: DatabaseTransaction, connectionIds: string[]) {
  const rows = await tx.query<QueryResultRow>({ name: "app_connection_credential_fields_v2", text: `SELECT
    connection_id,field_names_json FROM data.app_connector_credentials WHERE connection_id=ANY($1::text[])`,
  values: [connectionIds], maxRows: connectionIds.length });
  return new Map(rows.map((row) => [String(row.connection_id),
    Array.isArray(row.field_names_json) ? (row.field_names_json as unknown[]).map(String) : []]));
}

/** Connection rows as the App authority returns them, reading their details in two queries. */
async function connectionViews(tx: DatabaseTransaction, rows: QueryResultRow[], channelId?: string) {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => String(row.connection_id));
  const subscriptions = channelId ? await relationsByConnection(tx, ids, channelId) : new Map<string, Subscription[]>();
  const credentials = await credentialFieldsByConnection(tx, ids);
  return rows.map((row) => {
    const id = String(row.connection_id);
    const subscribed = subscriptions.get(id) ?? [];
    return { id, spaceId: String(row.space_id), providerId: String(row.provider_id),
      providerName: String(row.provider_name), status: String(row.status), authMode: String(row.auth_mode),
      scopes: row.scopes_json, secretRefs: row.secret_refs_json, capabilities: row.capabilities_json,
      channelIds: [], credentialFields: credentials.get(id) ?? [],
      createdBy: String(row.created_by), createdAt: iso(row.created_at as string | Date),
      updatedAt: iso(row.updated_at as string | Date),
      ...(row.last_checked_at ? { lastCheckedAt: iso(row.last_checked_at as string | Date) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
      ...(row.metadata_json ? { metadata: row.metadata_json } : {}), version: Number(row.version),
      ...(channelId ? { channelState: { channelId,
        enabled: true,
        bound: subscribed.length > 0, subscriptions: subscribed } } : {}) };
  });
}

async function connection(tx: DatabaseTransaction, row: QueryResultRow, channelId?: string) {
  return (await connectionViews(tx, [row], channelId))[0]!;
}

/**
 * An App execution row as every App authority returns it. The authorities
 * store its id and times differently, so they pass those in already read.
 */
export function appExecutionView(row: Record<string, unknown>,
  stored: { id: string; createdAt: string; updatedAt: string }) {
  return { id: stored.id, spaceId: String(row.space_id), channelId: String(row.channel_id),
    messageId: String(row.message_id), providerId: String(row.provider_id),
    providerName: String(row.provider_name), ...(row.action_id ? { actionId: String(row.action_id) } : {}),
    ...(row.action_label ? { actionLabel: String(row.action_label) } : {}), status: String(row.status),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    ...(row.connection_id ? { connectionId: String(row.connection_id) } : {}),
    ...(row.result_channel_id ? { resultChannelId: String(row.result_channel_id) } : {}),
    ...(row.result_summary ? { resultSummary: String(row.result_summary) } : {}),
    requestedBy: String(row.requested_by),
    ...(row.requested_by_label ? { requestedByLabel: String(row.requested_by_label) } : {}),
    version: Number(row.version), createdAt: stored.createdAt, updatedAt: stored.updatedAt };
}

function execution(row: QueryResultRow) {
  return appExecutionView(row, { id: String(row.execution_id), createdAt: iso(row.created_at as string | Date),
    updatedAt: iso(row.updated_at as string | Date) });
}

function relation(row: QueryResultRow) {
  return { id: String(row.relation_id), connectionId: String(row.connection_id),
    spaceId: String(row.space_id), channelId: String(row.channel_id), kind: String(row.source_kind),
    source: String(row.source_ref), features: row.features_json, version: Number(row.version),
    createdBy: String(row.created_by), createdAt: iso(row.created_at as string | Date),
    updatedAt: iso(row.updated_at as string | Date) };
}

export interface AppProviderPolicy {
  id: string; name: string; authMode: "oauth" | "api-token";
  scopes: string[]; secretRefs: string[];
  capabilities: Array<{ id: string; scopes: string[] }>;
  metadataFields: string[];
}

export interface PostgresGitHubSubscriptionRoute {
  installationId: string;
  sourceRef: string;
  /** `repository` for a repository subscription, `issue` for one issue or pull request. */
  sourceKind: "repository" | "issue";
  /** When the Channel subscribed; an issue subscription older than its issue named another one. */
  createdAt: string;
  spaceId: string;
  channelId: string;
  connectionId: string;
  authorityRootUserId: string;
}

type AppPrincipal = { kind: "user" | "agent"; id: string };

/** A route read's source and bound, shared by every ingress that resolves subscriptions. */
function routeRead(input: { sourceRef: string; limit: number }): { sourceRef: string; limit: number } {
  const sourceRef = text(input.sourceRef, "sourceRef", 300).toLowerCase();
  const limit = Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_001) throw new AppControlError(
    "invalid_app_request", 400, "limit is invalid");
  return { sourceRef, limit };
}

export class PostgresAppRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new AppControlError(
      "cached_authority_forbidden", 500, "App authority requires uncached PostgreSQL",
    );
  }

  async listConnections(input: { requestId: string; spaceId: string; actorUserId: string;
    channelId?: string; cursor?: string | null; limit: number }) {
    const requestId = text(input.requestId, "requestId", 200);
    const spaceId = text(input.spaceId, "spaceId", 300);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    const after = pageCursor(input.cursor, 2);
    const limit = Number(input.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new AppControlError(
      "invalid_app_request", 400, "limit is invalid");
    return this.database.transaction({ requestId, operation: "app.connections.list" }, async (tx) => {
      await requireSpace(tx, spaceId, actorUserId, false);
      if (input.channelId) await appChannelCapability(
        tx, input.channelId, { kind: "user", id: actorUserId }, "app_history_read");
      const rows = await tx.query<QueryResultRow>({ name: "app_connections_list_v1", text: `SELECT *
        FROM data.app_connector_connections WHERE space_id=$1
          AND ($2::text IS NULL OR (provider_id,connection_id)>($2,$3))
        ORDER BY provider_id,connection_id LIMIT $4`, values: [spaceId, after?.[0] ?? null,
        after?.[1] ?? null, limit + 1], maxRows: limit + 1 });
      const page = rows.slice(0, limit);
      return { connections: await connectionViews(tx, page, input.channelId),
        cursor: rows.length > limit && page.at(-1) ? JSON.stringify([
          String(page.at(-1)!.provider_id), String(page.at(-1)!.connection_id)]) : null };
    });
  }

  async getConnection(input: { requestId: string; connectionId: string; actorUserId: string;
    channelId?: string; allowMissing?: boolean }) {
    const requestId = text(input.requestId, "requestId", 200);
    const connectionId = text(input.connectionId, "connectionId", 300);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    return this.database.transaction({ requestId, operation: "app.connection.get" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "app_connection_get_v1", text: `SELECT *
        FROM data.app_connector_connections WHERE connection_id=$1 LIMIT 1`,
      values: [connectionId], maxRows: 1 });
      if (!rows[0]) {
        if (input.allowMissing) return { connection: null };
        throw new AppControlError("app_connection_not_found", 404, "App connection not found");
      }
      await requireSpace(tx, String(rows[0].space_id), actorUserId, false);
      if (input.channelId) await appChannelCapability(
        tx, input.channelId, { kind: "user", id: actorUserId }, "app_history_read");
      return { connection: await connection(tx, rows[0], input.channelId) };
    });
  }

  async listExecutions(input: { requestId: string; spaceId: string; actorUserId: string;
    cursor?: string | null; limit: number }) {
    const after = pageCursor(input.cursor, 2);
    const limit = Number(input.limit);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.executions.list" }, async (tx) => {
      await requireSpace(tx, text(input.spaceId, "spaceId", 300),
        text(input.actorUserId, "actorUserId", 300), false);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new AppControlError(
        "invalid_app_request", 400, "limit is invalid");
      const rows = await tx.query<QueryResultRow>({ name: "app_executions_list_v1", text: `SELECT *
        FROM data.app_connector_executions WHERE space_id=$1
          AND ($2::timestamptz IS NULL OR (created_at,execution_id)<($2,$3))
        ORDER BY created_at DESC,execution_id DESC LIMIT $4`, values: [input.spaceId,
        after?.[0] ?? null, after?.[1] ?? null, limit + 1], maxRows: limit + 1 });
      const page = rows.slice(0, limit);
      return { executions: page.map(execution), cursor: rows.length > limit && page.at(-1)
        ? JSON.stringify([iso(page.at(-1)!.created_at as string | Date),
          String(page.at(-1)!.execution_id)]) : null };
    });
  }

  async listRelations(input: { requestId: string; channelId: string; principal: AppPrincipal;
    cursor?: string | null; limit: number }) {
    const after = pageCursor(input.cursor, 4);
    const limit = Number(input.limit);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.relations.list" }, async (tx) => {
      await appChannelCapability(tx, text(input.channelId, "channelId", 300),
        input.principal, "app_history_read");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new AppControlError(
        "invalid_app_request", 400, "limit is invalid");
      const rows = await tx.query<QueryResultRow>({ name: "app_relations_list_v1", text: `SELECT *
        FROM data.app_source_relations WHERE channel_id=$1 AND ($2::text IS NULL OR
          (connection_id,source_kind,source_ref,relation_id)>($2,$3,$4,$5))
        ORDER BY connection_id,source_kind,source_ref,relation_id LIMIT $6`, values: [input.channelId,
        after?.[0] ?? null, after?.[1] ?? null, after?.[2] ?? null, after?.[3] ?? null,
        limit + 1], maxRows: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { relations: page.map(relation), cursor: rows.length > limit && last ? JSON.stringify([
        last.connection_id, last.source_kind, last.source_ref, last.relation_id]) : null };
    });
  }

  /** The Channels subscribed to `feature` of any of an event's sources: its
   * repository and the issue or pull request it is about. An event no
   * subscription takes (most of a busy repository's CI traffic) finds none
   * here instead of being read out connection by connection. */
  async githubSubscriptionRoutes(input: {
    requestId: string;
    installationId: string;
    sourceRefs: string[];
    feature: string;
    limit: number;
  }): Promise<PostgresGitHubSubscriptionRoute[]> {
    const installationId = text(input.installationId, "installationId", 100);
    const feature = text(input.feature, "feature", 40);
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length < 1 || input.sourceRefs.length > 20) {
      throw new AppControlError("invalid_app_request", 400, "sourceRefs is invalid");
    }
    const sourceRefs = input.sourceRefs.map((sourceRef) => routeRead({ sourceRef, limit: input.limit }).sourceRef);
    const { limit } = routeRead({ sourceRef: sourceRefs[0]!, limit: input.limit });
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.github-subscription-routes" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "app_github_subscription_routes_v4", text: `SELECT
        r.space_id,r.channel_id,r.connection_id,r.created_by,r.created_at,r.source_kind,lower(r.source_ref) AS source_ref
        FROM data.app_source_relations r JOIN data.app_connector_connections c
          ON c.connection_id=r.connection_id AND c.space_id=r.space_id
        JOIN data.channels channel ON channel.channel_id=r.channel_id
          AND channel.space_id=r.space_id
        WHERE c.provider_id='github' AND c.status='configured'
          AND r.source_kind IN ('repository','issue') AND lower(r.source_ref)=ANY($2::text[])
          AND jsonb_typeof(r.features_json)='array' AND r.features_json ? $4
          AND (c.metadata_json->>'installationId'=$1 OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(CASE
              WHEN jsonb_typeof(c.metadata_json->'installationIds')='array'
              THEN c.metadata_json->'installationIds' ELSE '[]'::jsonb END) AS linked(value)
            WHERE linked.value=$1))
        ORDER BY r.channel_id,r.space_id,r.connection_id,r.source_kind,lower(r.source_ref) LIMIT $3`,
      values: [installationId, sourceRefs, limit, feature], maxRows: limit });
      return rows.map((row) => ({ installationId, sourceRef: String(row.source_ref),
        sourceKind: row.source_kind === "issue" ? "issue" as const : "repository" as const,
        createdAt: iso(row.created_at as string | Date),
        spaceId: String(row.space_id), channelId: String(row.channel_id),
        connectionId: String(row.connection_id), authorityRootUserId: String(row.created_by) }));
    });
  }

  /** The Hub has authenticated the application's signature and workspace id.
   * Only current OAuth grants from that application may receive its events. */
  async oauthEventConnections(input: { requestId: string; providerId: string; appClientId: string;
    installationId: string; limit: number }) {
    const providerId = text(input.providerId, "providerId", 80);
    const appClientId = text(input.appClientId, "appClientId", 256);
    const installationId = text(input.installationId, "installationId", 128);
    if (!["slack", "linear"].includes(providerId) || !Number.isSafeInteger(input.limit) ||
        input.limit < 1 || input.limit > 100) throw new AppControlError("invalid_app_request", 400, "Invalid OAuth event route");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.oauth-event-connections" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "app_oauth_event_connections_v1", text: `SELECT
        i.connection_id,i.space_id FROM data.app_connector_oauth_installations i
        JOIN data.app_connector_connections c ON c.connection_id=i.connection_id AND c.space_id=i.space_id
          AND c.provider_id=i.provider_id AND c.status='configured'
        JOIN data.app_connector_credentials k ON k.connection_id=i.connection_id AND k.space_id=i.space_id
          AND k.version=i.credential_version
        WHERE i.provider_id=$1 AND i.app_client_id=$2 AND i.installation_id=$3
          AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=i.space_id)
        ORDER BY i.connection_id LIMIT $4`, values: [providerId, appClientId, installationId, input.limit + 1],
      maxRows: input.limit + 1 });
      if (rows.length > input.limit) throw new AppControlError("too_many_installations", 503,
        "OAuth installation routing exceeds its bound", true);
      return rows.map(row => ({ connectionId: String(row.connection_id), spaceId: String(row.space_id) }));
    });
  }

  /** An authenticated Vercel scope may have several independently restricted installations. */
  async vercelEventConnections(input: { requestId: string; appClientId: string; eventScopeId: string; limit: number }) {
    const appClientId = text(input.appClientId, "appClientId", 256);
    const scope = text(input.eventScopeId, "eventScopeId", 128);
    if (!/^(team|user)_[A-Za-z0-9_-]{1,80}$/u.test(scope) || !Number.isSafeInteger(input.limit) ||
        input.limit < 1 || input.limit > 100) throw new AppControlError("invalid_app_request", 400, "Invalid Vercel event route");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.vercel-event-connections" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "app_vercel_event_connections_v1", text: `SELECT
        i.connection_id,i.space_id,i.installation_id,i.credential_version
        FROM data.app_connector_oauth_installations i
        JOIN data.app_connector_connections c ON c.connection_id=i.connection_id AND c.space_id=i.space_id
          AND c.provider_id=i.provider_id AND c.status='configured'
        JOIN data.app_connector_credentials k ON k.connection_id=i.connection_id AND k.space_id=i.space_id
          AND k.version=i.credential_version
        WHERE i.provider_id='vercel' AND i.app_client_id=$1 AND i.event_scope_id=$2
          AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=i.space_id)
        ORDER BY i.connection_id LIMIT $3`, values: [appClientId, scope, input.limit + 1], maxRows: input.limit + 1 });
      if (rows.length > input.limit) throw new AppControlError("too_many_installations", 503,
        "Vercel installation routing exceeds its bound", true);
      return rows.map(row => ({ connectionId: String(row.connection_id), spaceId: String(row.space_id),
        installationId: String(row.installation_id), credentialVersion: Number(row.credential_version) }));
    });
  }

  /** Only a verified app removal/transfer delivery retires this exact current installation. */
  async retireVercelInstallation(input: { requestId: string; appClientId: string; installationId: string;
    eventScopeId: string; at: string; limit: number }): Promise<number> {
    const appClientId = text(input.appClientId, "appClientId", 256);
    const installationId = text(input.installationId, "installationId", 128);
    const scope = text(input.eventScopeId, "eventScopeId", 128);
    const at = iso(input.at);
    if (!/^icfg_[A-Za-z0-9]{1,80}$/u.test(installationId) || !/^(team|user)_[A-Za-z0-9_-]{1,80}$/u.test(scope) ||
        !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new AppControlError("invalid_app_request", 400, "Invalid Vercel retirement");
    }
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.vercel-installation-retire" }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "app_vercel_retirement_lock_v1", text: `SELECT i.connection_id
        FROM data.app_connector_oauth_installations i
        JOIN data.app_connector_connections c ON c.connection_id=i.connection_id AND c.space_id=i.space_id
          AND c.provider_id=i.provider_id AND c.status='configured'
        JOIN data.app_connector_credentials k ON k.connection_id=i.connection_id AND k.space_id=i.space_id
          AND k.version=i.credential_version
        WHERE i.provider_id='vercel' AND i.app_client_id=$1 AND i.installation_id=$2 AND i.event_scope_id=$3
          AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=i.space_id)
        ORDER BY i.connection_id LIMIT $4 FOR UPDATE OF c,k,i`,
      values: [appClientId, installationId, scope, input.limit + 1], maxRows: input.limit + 1 });
      if (rows.length > input.limit) throw new AppControlError("too_many_installations", 503,
        "Vercel retirement exceeds its bound", true);
      if (!rows.length) return 0;
      const ids = rows.map(row => String(row.connection_id));
      // Retain encrypted credential evidence (including manually supplied fields)
      // until the administrator reconnects. Disconnected grants cannot execute.
      await tx.query({ name: "app_vercel_retirement_state_v1", text: `UPDATE data.app_connector_connections
        SET status='disconnected',version=version+1,updated_at=$2 WHERE connection_id=ANY($1::text[])`, values: [ids, at], maxRows: 0 });
      await tx.query({ name: "app_vercel_retirement_binding_v1", text: `DELETE FROM
        data.app_connector_oauth_installations WHERE connection_id=ANY($1::text[])`, values: [ids], maxRows: 0 });
      return rows.length;
    });
  }

  /** Subscription authority, read only after authenticating the provider delivery. */
  async connectorEventRoutes(input: { requestId: string; connectionId: string; sourceRef: string;
    limit: number; oauthBinding?: { providerId: string; appClientId: string; installationId: string; credentialVersion?: number; grantGeneration?: string };
    googleChatBinding?: { appIdentity: string; chatSpace: string; grantGeneration: string };
    feishuBinding?: { appIdentity: string; chatSpace: string; grantGeneration: string };
    teamsBinding?: { appIdentity: string; chatSpace: string; grantGeneration: string };
    telegramBinding?: { appIdentity: string; chatSpace: string; grantGeneration: string };
    wecomBinding?: { appIdentity: string; companyDigest: string; grantGeneration: string } }) {
    const connectionId = text(input.connectionId, "connectionId", 300);
    const { sourceRef, limit } = routeRead(input);
    const binding = input.oauthBinding;
    const chat = input.teamsBinding ?? input.googleChatBinding ?? input.feishuBinding ?? input.telegramBinding;
    const roomProvider = input.teamsBinding ? "teams" : input.telegramBinding ? "telegram" : input.feishuBinding ? "feishu" : "googlechat";
    if (chat && (binding || [input.googleChatBinding, input.feishuBinding, input.telegramBinding, input.teamsBinding].filter(Boolean).length > 1 || !connectionId.endsWith(`:${roomProvider}`) || chat.appIdentity.length > 600 ||
        !(roomProvider === "teams" ? /^room-[a-f0-9]{64}$/u : roomProvider === "telegram" ? /^-[1-9][0-9]{0,15}$/u : roomProvider === "feishu" ? /^[A-Za-z0-9_-]{1,64}\/oc_[A-Za-z0-9]{4,64}$/u : /^spaces\/[A-Za-z0-9_-]{1,128}$/u).test(chat.chatSpace) || (roomProvider === "telegram" && !Number.isSafeInteger(Number(chat.chatSpace))) ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(chat.grantGeneration))) {
      throw new AppControlError("invalid_app_request", 400, "Invalid bot room route grant");
    }
    const wecom = input.wecomBinding;
    if (wecom && (chat || binding || !connectionId.endsWith(":wecom") || !/^wecom\|(?:ww|wx)[A-Za-z0-9]{8,64}\|[a-f0-9]{64}$/u.test(wecom.appIdentity) ||
        !/^[a-f0-9]{64}$/u.test(wecom.companyDigest) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(wecom.grantGeneration))) {
      throw new AppControlError("invalid_app_request", 400, "Invalid WeCom company route grant");
    }
    const bounded = binding?.providerId === "sentry" || !!chat || !!wecom;
    if (binding?.providerId === "vercel" && (!Number.isSafeInteger(binding.credentialVersion) || binding.credentialVersion! < 1)) {
      throw new AppControlError("invalid_app_request", 400, "Vercel route requires its credential version");
    }
    if (binding?.providerId === "sentry" && (!Number.isSafeInteger(binding.credentialVersion) || binding.credentialVersion! < 1 ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(binding.grantGeneration ?? ""))) {
      throw new AppControlError("invalid_app_request", 400, "Sentry route requires its current grant generation and version");
    }
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.connector-event-routes" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "app_connector_event_routes_v8", text: `SELECT
        r.space_id,r.channel_id,r.created_by,r.features_json
        FROM data.app_source_relations r JOIN data.app_connector_connections c
          ON c.connection_id=r.connection_id AND c.space_id=r.space_id
        JOIN data.channels channel ON channel.channel_id=r.channel_id AND channel.space_id=r.space_id
        WHERE r.connection_id=$1 AND c.status='configured' AND r.source_kind='repository'
          AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=r.space_id)
          AND lower(r.source_ref)=$2
          AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM data.app_connector_oauth_installations i
            JOIN data.app_connector_credentials k ON k.connection_id=i.connection_id AND k.space_id=i.space_id
              AND k.version=i.credential_version
            WHERE i.connection_id=c.connection_id AND i.space_id=c.space_id AND i.provider_id=c.provider_id
              AND i.provider_id=$4 AND i.app_client_id=$5 AND i.installation_id=$6
              AND ($7::bigint IS NULL OR i.credential_version=$7)
              AND ($8::uuid IS NULL OR i.grant_generation=$8::uuid)))
          AND ($9::text IS NULL OR ($12='googlechat' AND EXISTS (SELECT 1 FROM data.app_googlechat_room_bindings g
            WHERE g.connection_id=c.connection_id AND g.space_id=c.space_id AND c.provider_id='googlechat'
              AND g.active AND g.app_identity=$9 AND g.chat_space=$10 AND g.grant_generation=$11::uuid
              AND g.connection_generation=c.search_rank_sequence
              AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials v WHERE v.connection_id=c.connection_id)))
            OR ($12='feishu' AND EXISTS (SELECT 1 FROM data.app_feishu_room_bindings g
              JOIN data.app_feishu_tenant_lifecycle t ON t.app_identity=g.app_identity AND t.tenant_key=split_part(g.chat_space,'/',1)
              WHERE g.connection_id=c.connection_id AND g.space_id=c.space_id AND c.provider_id='feishu'
                AND g.active AND g.app_identity=$9 AND g.chat_space=$10 AND g.grant_generation=$11::uuid
                AND g.connection_generation=c.search_rank_sequence AND t.active AND g.confirmed_at>COALESCE(t.retired_at,'-infinity'::timestamptz)
                AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials v WHERE v.connection_id=c.connection_id)))
            OR ($12='teams' AND EXISTS (SELECT 1 FROM data.app_teams_room_bindings g
              WHERE g.connection_id=c.connection_id AND g.space_id=c.space_id AND c.provider_id='teams'
                AND g.active AND g.app_identity=$9 AND g.chat_space=$10 AND g.grant_generation=$11::uuid
                AND g.connection_generation=c.search_rank_sequence
                AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials v WHERE v.connection_id=c.connection_id)))
            OR ($12='telegram' AND EXISTS (SELECT 1 FROM data.app_telegram_room_bindings g
              WHERE g.connection_id=c.connection_id AND g.space_id=c.space_id AND c.provider_id='telegram'
                AND g.active AND g.app_identity=$9 AND g.chat_space=$10 AND g.grant_generation=$11::uuid
                AND g.connection_generation=c.search_rank_sequence
                AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials v WHERE v.connection_id=c.connection_id))))
          AND ($13::text IS NULL OR EXISTS (SELECT 1 FROM data.app_wecom_installations g
            WHERE g.connection_id=c.connection_id AND g.space_id=c.space_id AND c.provider_id='wecom'
              AND g.app_identity=$13 AND g.company_digest=$14 AND g.grant_generation=$15::uuid
              AND g.connection_generation=c.search_rank_sequence
              AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials k WHERE k.connection_id=g.connection_id)
              AND NOT EXISTS (SELECT 1 FROM data.app_wecom_company_lifecycle l WHERE l.app_identity=g.app_identity
                AND l.company_digest=g.company_digest AND l.changed_at>=g.started_at)))
        ORDER BY r.channel_id LIMIT $3`, values: [connectionId, sourceRef, bounded ? limit + 1 : limit, binding?.providerId ?? null,
          binding?.appClientId ?? null, binding?.installationId ?? null, binding?.credentialVersion ?? null,
          binding?.grantGeneration ?? null, chat?.appIdentity ?? null, chat?.chatSpace ?? null,
          chat?.grantGeneration ?? null, roomProvider, wecom?.appIdentity ?? null, wecom?.companyDigest ?? null, wecom?.grantGeneration ?? null], maxRows: bounded ? limit + 1 : limit });
      if (bounded && rows.length > limit) throw new AppControlError("too_many_routes", 503,
        chat ? "Google Chat event routing exceeds its bound" : "Sentry event routing exceeds its bound", true);
      return rows.map((row) => ({ spaceId: String(row.space_id), channelId: String(row.channel_id),
        authorityRootUserId: String(row.created_by),
        features: Array.isArray(row.features_json) ? (row.features_json as unknown[]).map(String) : [] }));
    });
  }

  async upsert(input: { commandId: string; spaceId: string; actorUserId: string;
    provider: AppProviderPolicy; body: Record<string, unknown>; at: string }) {
    const commandId = text(input.commandId, "commandId", 200);
    const spaceId = text(input.spaceId, "spaceId", 300);
    const actorUserId = text(input.actorUserId, "actorUserId", 300);
    const providerId = text(input.provider.id, "provider.id", 80).toLowerCase();
    const body = object(input.body, "body");
    const at = iso(input.at);
    const requestDigest = await digest({ ...input, at: undefined });
    return this.database.transaction({ requestId: commandId, operation: "app.connection.upsert" },
      async (tx) => {
        const replay = { scopeKind: "user", scopeId: actorUserId, commandId,
          commandKind: "app.connection.upsert", requestDigest };
        const prior = await readScopedCommandReplay(tx, "app_replay_read_v1", replay, reusedCommand);
        if (prior) return { ...prior, reused: true };
        await requireSpace(tx, spaceId, actorUserId, true);
        const id = `${spaceId}:${providerId}`;
        const rows = await tx.query<QueryResultRow>({ name: "app_connection_lock_v1", text: `SELECT *
          FROM data.app_connector_connections WHERE connection_id=$1 FOR UPDATE`, values: [id], maxRows: 1 });
        const current = rows[0];
        if (body.initializeOnly !== undefined && typeof body.initializeOnly !== "boolean") {
          throw new AppControlError("invalid_app_request", 400, "initializeOnly is invalid");
        }
        if (body.initializeOnly === true && current) {
          const result = { connection: await connection(tx, current), reused: false };
          await storeScopedCommandReplay(tx, "app_replay_write_v1", { ...replay, result, at, ttlMs: REPLAY_TTL_MS });
          return result;
        }
        const status = body.status === undefined ? String(current?.status ?? "configured") : body.status;
        if (status !== "configured" && status !== "disconnected" && status !== "error") {
          throw new AppControlError("invalid_app_request", 400, "status is invalid");
        }
        const authMode = body.authMode === undefined ? String(current?.auth_mode ?? input.provider.authMode) : body.authMode;
        if (authMode !== input.provider.authMode) throw new AppControlError(
          "invalid_app_request", 400, `authMode must be ${input.provider.authMode}`);
        const scopes = array(body.scopes, "scopes", (current?.scopes_json as string[] | undefined) ?? []);
        if (scopes.some((item) => !input.provider.scopes.includes(item))) throw new AppControlError(
          "invalid_app_request", 400, "Unsupported connector scope");
        const secretRefs = array(body.secretRefs, "secretRefs",
          (current?.secret_refs_json as string[] | undefined) ?? []);
        if (secretRefs.some((item) => !input.provider.secretRefs.includes(item))) throw new AppControlError(
          "invalid_app_request", 400, "Unsupported connector secret ref");
        const derived = input.provider.capabilities.filter((capability) =>
          capability.scopes.every((scope) => scopes.includes(scope))).map((capability) => capability.id);
        const capabilities = array(body.capabilities, "capabilities",
          (current?.capabilities_json as string[] | undefined) ?? derived);
        if (capabilities.some((item) => !input.provider.capabilities.some((allowed) => allowed.id === item))) {
          throw new AppControlError("invalid_app_request", 400, "Unsupported connector capability");
        }
        const channelIds: string[] = [];
        const metadata = appendMetadataLists(body.metadata === undefined
          ? (current?.metadata_json as Record<string, unknown> | undefined) ?? {}
          : object(body.metadata, "metadata"), body.metadataAppend);
        if (Object.keys(metadata).some((key) => !input.provider.metadataFields.includes(key))) {
          throw new AppControlError("invalid_app_request", 400,
            "Connector metadata contains an unsupported field");
        }
        // A connection belongs to the Space; Agents reach it through their
        // registration's approved resources, never through a bound Agent.
        if (body.agentId !== undefined && body.agentId !== null) throw new AppControlError(
          "invalid_app_request", 400, "Connector connections are not bound to an Agent");
        const version = Number(current?.version ?? 0) + 1;
        if (providerId === "wecom" && status === "disconnected") {
          await tx.query({ name: "wecom_disconnect_installation_v1", text: "DELETE FROM data.app_wecom_installations WHERE connection_id=$1", values: [id], maxRows: 0 });
          await tx.query({ name: "wecom_disconnect_attempt_v1", text: "DELETE FROM data.app_wecom_install_attempts WHERE connection_id=$1", values: [id], maxRows: 0 });
        }
        const error = status === "error" && typeof body.error === "string" ? body.error.slice(0, 240) : null;
        if (current) await tx.query({ name: "app_connection_update_v2", text: `UPDATE
          data.app_connector_connections SET provider_name=$1,status=$2,auth_mode=$3,scopes_json=$4::jsonb,
          secret_refs_json=$5::jsonb,capabilities_json=$6::jsonb,channel_ids_json=$7::jsonb,
          agent_id=NULL,metadata_json=$8::jsonb,version=$9,updated_at=$10,error=$11
          WHERE connection_id=$12 AND version=$13`, values: [input.provider.name, status, authMode,
          JSON.stringify(scopes), JSON.stringify(secretRefs), JSON.stringify(capabilities), JSON.stringify(channelIds),
          JSON.stringify(metadata), version, at, error, id, current.version], maxRows: 0 });
        else await tx.query({ name: "app_connection_insert_v1", text: `INSERT INTO
          data.app_connector_connections (connection_id,space_id,provider_id,provider_name,status,auth_mode,
          scopes_json,secret_refs_json,capabilities_json,channel_ids_json,agent_id,created_by,metadata_json,
          search_rank_sequence,version,created_at,updated_at,last_checked_at,error)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::jsonb,
            $14,1,$15,$15,NULL,$16)`, values: [id, spaceId, providerId, input.provider.name, status,
          authMode, JSON.stringify(scopes), JSON.stringify(secretRefs), JSON.stringify(capabilities),
          JSON.stringify(channelIds), null, actorUserId, JSON.stringify(metadata),
          `app-connection:${at}:${commandId}`, at, error], maxRows: 0 });
        const updated = await tx.query<QueryResultRow>({ name: "app_connection_updated_v1",
          text: "SELECT * FROM data.app_connector_connections WHERE connection_id=$1 LIMIT 1",
          values: [id], maxRows: 1 });
        const result = { connection: await connection(tx, updated[0]!), reused: false };
        await storeScopedCommandReplay(tx, "app_replay_write_v1", { ...replay, result, at, ttlMs: REPLAY_TTL_MS });
        return result;
      });
  }

  async command(input: Record<string, unknown>, kind: "delete" | "check" | "put-relation" |
    "remove-relation" | "record-execution" | "finalize-execution") {
    const commandId = text(input.commandId, "commandId", 200);
    const actor = appPrincipal(input);
    const at = iso(typeof input.at === "string" ? input.at : new Date().toISOString());
    const requestDigest = await digest({ ...input, at: undefined });
    return this.database.transaction({ requestId: commandId, operation: `app.${kind}` }, async (tx) => {
      const replay = { scopeKind: "user", scopeId: actor.id, commandId, commandKind: `app.${kind}`, requestDigest };
      const prior = await readScopedCommandReplay(tx, "app_replay_read_v1", replay, reusedCommand);
      if (prior) return { ...prior, reused: true };
      let result: Record<string, unknown>;
      if (kind === "delete") result = await this.deleteConnection(tx, input, actor);
      else if (kind === "check") result = await this.checkConnection(tx, input, actor, at);
      else if (kind === "put-relation") result = await this.putRelation(tx, input, actor, at);
      else if (kind === "remove-relation") result = await this.removeRelation(tx, input, actor);
      else if (kind === "record-execution") result = await this.recordExecution(tx, input, actor, at);
      else result = await this.finalizeExecution(tx, input, actor, at);
      await storeScopedCommandReplay(tx, "app_replay_write_v1", { ...replay, result, at, ttlMs: REPLAY_TTL_MS });
      return result;
    });
  }

  private async deleteConnection(tx: DatabaseTransaction, input: Record<string, unknown>, actor: AppPrincipal) {
    if (actor.kind !== "user") throw new AppControlError("forbidden", 403, "only users manage connections");
    const spaceId = text(input.spaceId, "spaceId", 300);
    await requireSpace(tx, spaceId, actor.id, true);
    const providerId = text(input.providerId, "providerId", 80).toLowerCase();
    const rows = await tx.query<QueryResultRow>({ name: "app_connection_delete_lock_v1", text: `SELECT *
      FROM data.app_connector_connections WHERE space_id=$1 AND provider_id=$2 FOR UPDATE`,
    values: [spaceId, providerId], maxRows: 1 });
    if (!rows[0]) throw new AppControlError("app_connection_not_found", 404, "App connection not found");
    await tx.query({ name: "app_relation_delete_connection_v1",
      text: "DELETE FROM data.app_source_relations WHERE connection_id=$1",
      values: [rows[0].connection_id], maxRows: 0 });
    await tx.query({ name: "app_credential_delete_connection_v1",
      text: "DELETE FROM data.app_connector_credentials WHERE connection_id=$1",
      values: [rows[0].connection_id], maxRows: 0 });
    await tx.query({ name: "app_action_policy_delete_connection_v1",
      text: "DELETE FROM data.app_connector_action_policies WHERE connection_id=$1",
      values: [rows[0].connection_id], maxRows: 0 });
    await tx.query({ name: "app_connection_delete_v1", text: `DELETE FROM data.app_connector_connections
      WHERE connection_id=$1 AND version=$2`, values: [rows[0].connection_id, rows[0].version], maxRows: 0 });
    return { ok: true, reused: false };
  }

  private async checkConnection(tx: DatabaseTransaction, input: Record<string, unknown>, actor: AppPrincipal, at: string) {
    if (actor.kind !== "user") throw new AppControlError("forbidden", 403, "only users manage connections");
    const connectionId = text(input.connectionId, "connectionId", 300);
    const rows = await tx.query<QueryResultRow>({ name: "app_connection_check_lock_v1", text: `SELECT *
      FROM data.app_connector_connections WHERE connection_id=$1 FOR UPDATE`, values: [connectionId], maxRows: 1 });
    if (!rows[0]) throw new AppControlError("app_connection_not_found", 404, "App connection not found");
    await requireSpace(tx, String(rows[0].space_id), actor.id, true);
    const expected = Number(input.expectedVersion);
    if (!Number.isSafeInteger(expected) || Number(rows[0].version) !== expected) throw new AppControlError(
      "version_conflict", 409, "App connection changed during provider check", true);
    const ok = input.ok === true;
    const message = text(input.message, "message", 240);
    await tx.query({ name: "app_connection_check_v1", text: `UPDATE data.app_connector_connections SET
      status=$1,error=$2,last_checked_at=$3,updated_at=$3,version=version+1
      WHERE connection_id=$4 AND version=$5`, values: [ok ? "configured" : "error", ok ? null : message,
      at, connectionId, expected], maxRows: 0 });
    const updated = await tx.query<QueryResultRow>({ name: "app_connection_checked_v1",
      text: "SELECT * FROM data.app_connector_connections WHERE connection_id=$1 LIMIT 1",
      values: [connectionId], maxRows: 1 });
    return { ok, connection: await connection(tx, updated[0]!), checkedAt: at, message, reused: false };
  }

  private async putRelation(tx: DatabaseTransaction, input: Record<string, unknown>, actor: AppPrincipal, at: string) {
    const connectionId = text(input.connectionId, "connectionId", 300);
    const channelId = text(input.channelId, "channelId", 300);
    const sourceKind = text(input.sourceKind, "sourceKind", 80);
    if (sourceKind !== "repository" && sourceKind !== "issue") throw new AppControlError(
      "invalid_app_request", 400, "sourceKind is invalid");
    const sourceRef = text(input.sourceRef, "sourceRef", 300);
    const features = array(input.features, "features");
    const rows = await tx.query<QueryResultRow>({ name: "app_relation_connection_v1", text: `SELECT *
      FROM data.app_connector_connections WHERE connection_id=$1 LIMIT 1`, values: [connectionId], maxRows: 1 });
    const current = rows[0];
    if (!current || current.status !== "configured") throw new AppControlError(
      "app_connection_not_found", 404, "Configured app connection not found");
    const authorized = await appChannelCapability(tx, channelId, actor, "app_new_work");
    if (authorized.spaceId !== current.space_id) throw new AppControlError("channel_not_found", 404, "Channel not found");
    const relationId = `${connectionId}:${channelId}:${sourceKind}:${sourceRef}`;
    if (relationId.length > 300) throw new AppControlError("invalid_app_request", 400, "relation identity is too large");
    const existing = await tx.query<QueryResultRow>({ name: "app_relation_lock_v1", text: `SELECT *
      FROM data.app_source_relations WHERE relation_id=$1 FOR UPDATE`, values: [relationId], maxRows: 1 });
    const version = Number(existing[0]?.version ?? 0) + 1;
    await tx.query({ name: "app_relation_upsert_v1", text: `INSERT INTO data.app_source_relations
      (relation_id,connection_id,space_id,channel_id,source_kind,source_ref,features_json,version,
       created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
      ON CONFLICT (relation_id) DO UPDATE SET features_json=EXCLUDED.features_json,
        version=data.app_source_relations.version+1,updated_at=EXCLUDED.updated_at`, values: [relationId,
      connectionId, current.space_id, channelId, sourceKind, sourceRef, JSON.stringify(features), version,
      existing[0]?.created_by ?? actor.id, existing[0]?.created_at ?? at, at], maxRows: 0 });
    const updated = await tx.query<QueryResultRow>({ name: "app_relation_updated_v1",
      text: "SELECT * FROM data.app_source_relations WHERE relation_id=$1 LIMIT 1",
      values: [relationId], maxRows: 1 });
    return { relation: relation(updated[0]!), reused: false };
  }

  private async removeRelation(tx: DatabaseTransaction, input: Record<string, unknown>, actor: AppPrincipal) {
    const relationId = text(input.relationId, "relationId", 300);
    const target = await tx.query<QueryResultRow>({ name: "app_relation_remove_target_v1",text:
      "SELECT channel_id FROM data.app_source_relations WHERE relation_id=$1",values: [relationId],maxRows: 1 });
    if (!target[0]) throw new AppControlError("source_relation_not_found",404,"Source relation not found");
    // Subscription writers share Channel -> relation order with guarded message effects.
    await appChannelCapability(tx,String(target[0].channel_id),actor,"app_terminalize");
    const rows = await tx.query<QueryResultRow>({ name: "app_relation_remove_lock_v1", text: `SELECT *
      FROM data.app_source_relations WHERE relation_id=$1 FOR UPDATE`, values: [relationId], maxRows: 1 });
    if (!rows[0]) throw new AppControlError("source_relation_not_found", 404, "Source relation not found");
    if (rows[0].channel_id!==target[0].channel_id) throw new AppControlError("source_relation_changed",409,"Source relation changed");
    await tx.query({ name: "app_relation_remove_v1", text: `DELETE FROM data.app_source_relations
      WHERE relation_id=$1 AND version=$2`, values: [relationId, rows[0].version], maxRows: 0 });
    return { ok: true, reused: false };
  }

  private async recordExecution(tx: DatabaseTransaction, input: Record<string, unknown>, actor: AppPrincipal, at: string) {
    const executionId = text(input.executionId, "executionId", 300);
    const connectionId = text(input.connectionId, "connectionId", 300);
    const channelId = text(input.channelId, "channelId", 300);
    const rows = await tx.query<QueryResultRow>({ name: "app_execution_connection_v1", text: `SELECT *
      FROM data.app_connector_connections WHERE connection_id=$1 LIMIT 1`, values: [connectionId], maxRows: 1 });
    if (!rows[0]) throw new AppControlError("app_connection_not_found", 404, "App connection not found");
    const authorized = await appChannelCapability(tx, channelId, actor, "app_new_work");
    if (authorized.spaceId !== rows[0].space_id) throw new AppControlError("channel_not_found", 404, "Channel not found");
    const exists = await tx.query({ name: "app_execution_exists_v1", text: `SELECT execution_id
      FROM data.app_connector_executions WHERE execution_id=$1 LIMIT 1`, values: [executionId], maxRows: 1 });
    if (exists[0]) throw new AppControlError("execution_exists", 409, "App execution already exists");
    await tx.query({ name: "app_execution_record_v1", text: `INSERT INTO data.app_connector_executions
      (execution_id,space_id,channel_id,message_id,provider_id,provider_name,action_id,action_label,
       status,dispatch_state,reason,connection_id,result_channel_id,result_summary,requested_by,
       requested_by_label,version,created_at,updated_at) VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,'queued','pending',NULL,$9,NULL,NULL,$10,$11,1,$12,$12)`, values: [
      executionId, rows[0].space_id, channelId, text(input.messageId, "messageId", 300),
      rows[0].provider_id, rows[0].provider_name,
      input.actionId === undefined ? null : text(input.actionId, "actionId", 100),
      input.actionLabel === undefined ? null : text(input.actionLabel, "actionLabel", 120),
      connectionId, actor.id,
      input.requestedByLabel === undefined ? null : text(input.requestedByLabel, "requestedByLabel", 120), at], maxRows: 0 });
    const created = await tx.query<QueryResultRow>({ name: "app_execution_recorded_v1",
      text: "SELECT * FROM data.app_connector_executions WHERE execution_id=$1 LIMIT 1",
      values: [executionId], maxRows: 1 });
    return { execution: execution(created[0]!), reused: false };
  }

  private async finalizeExecution(tx: DatabaseTransaction, input: Record<string, unknown>, actor: AppPrincipal, at: string) {
    const executionId = text(input.executionId, "executionId", 300);
    const rows = await tx.query<QueryResultRow>({ name: "app_execution_finalize_lock_v1", text: `SELECT *
      FROM data.app_connector_executions WHERE execution_id=$1 FOR UPDATE`, values: [executionId], maxRows: 1 });
    const current = rows[0];
    if (!current) throw new AppControlError("execution_not_found", 404, "App execution not found");
    await appChannelCapability(tx, String(current.channel_id), actor, "app_terminalize");
    const expected = Number(input.expectedVersion);
    if (!Number.isSafeInteger(expected) || Number(current.version) !== expected || current.dispatch_state !== "pending") {
      throw new AppControlError("version_conflict", 409, "App execution changed during provider I/O", true);
    }
    const status = text(input.status, "status", 80);
    if (!new Set(["completed", "failed", "blocked", "planned"]).has(status)) throw new AppControlError(
      "invalid_app_request", 400, "terminal execution status is invalid");
    const reason = input.reason === undefined ? null : text(input.reason, "reason", 500);
    const summary = input.resultSummary === undefined ? null : text(input.resultSummary, "resultSummary", 1000);
    const resultChannelId = input.resultChannelId === undefined ? null
      : text(input.resultChannelId, "resultChannelId", 300);
    await tx.query({ name: "app_execution_finalize_v1", text: `UPDATE data.app_connector_executions SET
      status=$1,reason=$2,result_channel_id=$3,result_summary=$4,dispatch_state='terminal',
      version=version+1,updated_at=$5 WHERE execution_id=$6 AND version=$7 AND dispatch_state='pending'`,
    values: [status, reason, resultChannelId, summary, at, executionId, expected], maxRows: 0 });
    const updated = await tx.query<QueryResultRow>({ name: "app_execution_finalized_v1",
      text: "SELECT * FROM data.app_connector_executions WHERE execution_id=$1 LIMIT 1",
      values: [executionId], maxRows: 1 });
    return { execution: execution(updated[0]!), reused: false };
  }
}
