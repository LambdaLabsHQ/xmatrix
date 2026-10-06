import type { QueryResultRow } from "pg";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import {
  decryptSecretValue,
  encryptSecretValue,
} from "./secret-value-control.js";
import { commandFields } from "./command-fields.js";
import { ControlError } from "./control-error.js";

const MAX_TTL_MS = 15 * 60_000;
const SECRET_PREFIX = "internal/oauth/slack/";

export class SlackOAuthControlError extends ControlError {
  override name = "SlackOAuthControlError";
}

interface SessionRow extends QueryResultRow {
  grant_id: string;
  oauth_state: string;
  owner_user_id: string;
  status: "pending" | "approved" | "consumed" | "expired";
  interval_seconds: number;
  secret_ref: string | null;
  /** The approved Slack token, encrypted and bound to the owner and secret_ref, until consumed. */
  token_json: unknown;
  team_name: string | null;
  version: string | number;
  start_command_id: string;
  approve_command_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
}

const { text } = commandFields((field) =>
  new SlackOAuthControlError("invalid_command", 400, `${field} is invalid`));

function principal(input: Record<string, unknown>, ownerUserId: string): void {
  const value = input.principal;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value as Record<string, unknown>).kind !== "user" ||
      (value as Record<string, unknown>).id !== ownerUserId) {
    throw new SlackOAuthControlError("forbidden", 403, "Slack OAuth owner mismatch");
  }
}

function grantFromState(value: unknown): { grantId: string; state: string } {
  const state = text(value, "state");
  const separator = state.indexOf(".");
  const grantId = separator > 0 ? state.slice(0, separator) : "";
  const nonce = separator > 0 ? state.slice(separator + 1) : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(grantId) ||
      !/^[a-f0-9]{64}$/u.test(nonce)) {
    throw new SlackOAuthControlError("slack_oauth_not_found", 404,
      "Unknown Slack authorization state");
  }
  return { grantId, state };
}

function iso(value: Date | string): string {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new SlackOAuthControlError(
    "postgres_fact_invalid", 500, "Slack OAuth timestamp is invalid");
  return result.toISOString();
}

function ownedCommand(input: Record<string, unknown>) {
  const commandId = text(input.commandId, "commandId", 200);
  const ownerUserId = text(input.ownerUserId, "ownerUserId");
  principal(input, ownerUserId);
  return { commandId, ownerUserId, grantId: text(input.grantId, "grantId") };
}

function status(row: SessionRow): Record<string, unknown> {
  if (row.status === "expired" || Date.parse(iso(row.expires_at)) <= Date.now()) {
    return { status: "expired", error: "Slack authorization expired" };
  }
  if (row.status === "consumed") return { status: "consumed" };
  return {
    status: row.status,
    interval: Number(row.interval_seconds),
    expiresAt: iso(row.expires_at),
    ...(row.status === "approved" && row.team_name ? { team: row.team_name } : {}),
  };
}

async function session(tx: DatabaseTransaction, grantId: string, lock = false) {
  return (await tx.query<SessionRow>({ name: lock ? "slack_oauth_session_lock_v1"
    : "slack_oauth_session_read_v1", text: `SELECT * FROM data.slack_oauth_sessions
      WHERE grant_id=$1 LIMIT 1${lock ? " FOR UPDATE" : ""}`,
  values: [grantId], maxRows: 1 }))[0];
}

/** An approved session holds its Slack token, encrypted, only until the
 * daemon consumes it or it expires; an owner holds at most 128 at once. */
async function requireTokenCapacity(tx: DatabaseTransaction, ownerUserId: string) {
  const rows = await tx.query<QueryResultRow>({ name: "slack_oauth_token_capacity_v2", text: `SELECT
    count(*)::int AS count FROM data.slack_oauth_sessions WHERE owner_user_id=$1 AND token_json IS NOT NULL`,
  values: [ownerUserId], maxRows: 1 });
  if (Number(rows[0]?.count ?? 0) >= 128) throw new SlackOAuthControlError(
    "storage_backpressure", 503, "Too many Slack authorizations are pending", true);
}

async function pruneExpired(tx: DatabaseTransaction, ownerUserId: string): Promise<void> {
  await tx.query({ name: "slack_oauth_prune_sessions_v2", text: `UPDATE data.slack_oauth_sessions
    SET status='expired',token_json=NULL,version=version+1,updated_at=now()
    WHERE grant_id IN (SELECT grant_id FROM data.slack_oauth_sessions WHERE owner_user_id=$1
      AND expires_at<=now() AND (status<>'expired' OR token_json IS NOT NULL) ORDER BY expires_at,grant_id LIMIT 128)`,
  values: [ownerUserId], maxRows: 0 });
}

export class PostgresSlackOAuthRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {
    if (database.cacheMode !== "disabled") throw new SlackOAuthControlError(
      "cached_authority_forbidden", 500, "Slack OAuth requires uncached PostgreSQL");
    if (!material.trim()) throw new SlackOAuthControlError(
      "secret_authority_unavailable", 503, "Secret encryption is not configured", true);
  }

  async start(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { commandId, ownerUserId, grantId } = ownedCommand(input);
    const state = text(input.state, "state");
    if (grantFromState(state).grantId !== grantId) throw new SlackOAuthControlError(
      "invalid_command", 400, "Slack OAuth state does not bind the grant");
    const clientId = text(input.clientId, "clientId", 512);
    const redirectUri = text(input.redirectUri, "redirectUri", 2048);
    const interval = input.interval === undefined ? 2 : Number(input.interval);
    if (!Number.isSafeInteger(interval) || interval < 1 || interval > 30) {
      throw new SlackOAuthControlError("invalid_command", 400, "Slack OAuth interval is invalid");
    }
    const ttlMs = Math.min(input.ttlMs === undefined ? 10 * 60_000 : Number(input.ttlMs), MAX_TTL_MS);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new SlackOAuthControlError(
      "invalid_command", 400, "Slack OAuth ttl is invalid");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    await this.database.transaction({ requestId: commandId, operation: "slack-oauth.start" }, async (tx) => {
      const current = await session(tx, grantId, true);
      if (current) {
        if (current.start_command_id !== commandId || current.oauth_state !== state ||
            current.owner_user_id !== ownerUserId) throw new SlackOAuthControlError(
          "idempotency_conflict", 409, "Slack OAuth grant id was already used");
        return;
      }
      await tx.query({ name: "slack_oauth_start_v1", text: `INSERT INTO data.slack_oauth_sessions
        (grant_id,oauth_state,owner_user_id,status,interval_seconds,secret_ref,team_name,version,
         start_command_id,approve_command_id,created_at,updated_at,expires_at,approved_at,consumed_at)
        VALUES ($1,$2,$3,'pending',$4,NULL,NULL,1,$5,NULL,$6,$6,$7,NULL,NULL)`,
      values: [grantId, state, ownerUserId, interval, commandId, now.toISOString(), expiresAt], maxRows: 0 });
    });
    const authorizationUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("user_scope",
      "channels:history,channels:read,groups:history,groups:read,users:read,users:read.email");
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("state", state);
    return { grantId, authorizationUrl: authorizationUrl.toString(),
      expiresIn: Math.floor(ttlMs / 1000), interval };
  }

  async approve(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const commandId = text(input.commandId, "commandId", 200);
    // Only the user who started the grant may approve it, so an authorize link
    // sent to someone else cannot hand that person's Slack token to the sender.
    const ownerUserId = text(input.ownerUserId, "ownerUserId");
    const { grantId, state } = grantFromState(input.state);
    const token = input.slackToken === undefined ? undefined : text(input.slackToken, "slackToken", 8192);
    const requestedTeam = input.team === undefined ? null : text(input.team, "team");
    const team = token && requestedTeam?.includes(token) ? null : requestedTeam;
    const secretRef = `${SECRET_PREFIX}${grantId}`;
    return this.database.transaction({ requestId: commandId, operation: "slack-oauth.approve" }, async (tx) => {
      const row = await session(tx, grantId, true);
      if (!row || row.oauth_state !== state || row.owner_user_id !== ownerUserId) throw new SlackOAuthControlError(
        "slack_oauth_not_found", 404, "Unknown Slack authorization state");
      if (Date.parse(iso(row.expires_at)) <= Date.now()) {
        await tx.query({ name: "slack_oauth_expire_v1", text: `UPDATE data.slack_oauth_sessions
          SET status='expired',version=version+1,updated_at=now() WHERE grant_id=$1`,
        values: [grantId], maxRows: 0 });
        throw new SlackOAuthControlError("slack_oauth_expired", 410, "Slack authorization expired");
      }
      if (row.status === "approved") return { ok: true, ...(row.team_name ? { team: row.team_name } : {}) };
      if (row.status !== "pending") throw new SlackOAuthControlError(
        "slack_oauth_state_conflict", 409, "Slack authorization state changed");
      if (!token) throw new SlackOAuthControlError(
        "slack_oauth_exchange_required", 428, "Slack authorization code exchange is required");
      await pruneExpired(tx, row.owner_user_id);
      await requireTokenCapacity(tx, row.owner_user_id);
      const sealed = await encryptSecretValue(this.material, row.owner_user_id, secretRef, 1, token);
      await tx.query({ name: "slack_oauth_approve_v2", text: `UPDATE data.slack_oauth_sessions SET
        status='approved',secret_ref=$2,token_json=$3::jsonb,team_name=COALESCE($4,team_name),approve_command_id=$5,
        version=version+1,updated_at=now(),approved_at=now() WHERE grant_id=$1`,
      values: [grantId, secretRef, JSON.stringify(sealed), team, commandId], maxRows: 0 });
      return { ok: true, ...(team ? { team } : {}) };
    });
  }

  async get(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ownerUserId = text((input.principal as Record<string, unknown> | undefined)?.id,
      "principal.id");
    principal(input, ownerUserId);
    const grantId = text(input.grantId, "grantId");
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "slack-oauth.get" },
      async (tx) => {
        const row = await session(tx, grantId);
        if (!row || row.owner_user_id !== ownerUserId) throw new SlackOAuthControlError(
          "slack_oauth_not_found", 404, "Slack authorization not found");
        return status(row);
      });
  }

  async consume(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { commandId, ownerUserId, grantId } = ownedCommand(input);
    return this.database.transaction({ requestId: commandId, operation: "slack-oauth.consume" }, async (tx) => {
      const row = await session(tx, grantId, true);
      if (!row || row.owner_user_id !== ownerUserId) throw new SlackOAuthControlError(
        "slack_oauth_not_found", 404, "Slack authorization not found");
      if (Date.parse(iso(row.expires_at)) <= Date.now() || row.status === "expired") {
        await tx.query({ name: "slack_oauth_consume_expire_v2", text: `UPDATE data.slack_oauth_sessions
          SET status='expired',token_json=NULL,version=version+1,updated_at=now()
          WHERE grant_id=$1 AND (status<>'expired' OR token_json IS NOT NULL)`, values: [grantId], maxRows: 0 });
        return { status: "expired", error: "Slack authorization expired" };
      }
      if (row.status === "consumed") throw new SlackOAuthControlError(
        "slack_oauth_consumed", 409, "Slack authorization was already consumed");
      if (row.status !== "approved" || !row.secret_ref) return status(row);
      if (!row.token_json) throw new SlackOAuthControlError(
        "slack_oauth_secret_missing", 409, "Slack authorization secret is unavailable");
      const slackToken = await decryptSecretValue(this.material, { owner_user_id: row.owner_user_id,
        secret_ref: row.secret_ref, authority_version: 1, encrypted_value_json: row.token_json });
      await tx.query({ name: "slack_oauth_consume_v2", text: `UPDATE data.slack_oauth_sessions SET
        status='consumed',token_json=NULL,version=version+1,updated_at=now(),consumed_at=now() WHERE grant_id=$1`,
      values: [grantId], maxRows: 0 });
      // Plaintext is deliberately returned once and never enters replay/outbox storage.
      return { status: "approved", slackToken, ...(row.team_name ? { team: row.team_name } : {}) };
    });
  }
}
