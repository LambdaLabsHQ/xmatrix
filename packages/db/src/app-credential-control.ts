import type { QueryResultRow } from "pg";
import { SENTRY_PUBLIC_INTEGRATION_SCOPES, utf8ByteLength } from "@xmatrix/protocol";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";
import { decryptSecretValue, encryptSecretValue } from "./secret-value-control.js";
import { lockDiscordInstallation } from "./discord-installation-lifecycle.js";
import { beginSentryAttempt, lockSentryAttempt, consumeSentryAttempt, retireSentryAttempt } from "./sentry-installation-lifecycle.js";

/*
 * A connection's provider credentials (docs/design/connector-platform.md §3.2).
 * The values are one AES-GCM envelope bound to the connection and its version,
 * written only by a Space owner or admin. Reads by a member expose field names;
 * only the Hub's connector executor and event ingress decrypt the values, and
 * neither the request nor its result is kept in a command replay.
 */

const MAX_FIELDS = 16;
const MAX_VALUE_BYTES = 8 * 1024;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

export interface AppCredentialFieldPolicy {
  /** Every field the provider manifest declares. */
  allowed: readonly string[];
}

/** Only the Hub's code exchange may supply this provider-authenticated binding. */
export interface AppOAuthInstallation {
  appClientId: string;
  installationId: string;
  /** Vercel account, Sentry app UUID, or Discord installing user; distinct from installation id. */
  eventScopeId?: string;
  /** Discord signed Connect start; remains stable across rotating refreshes. */
  discordAuthorizedAt?: string;
}

export interface ResolvedAppCredentials {
  connectionId: string;
  spaceId: string;
  providerId: string;
  status: string;
  createdBy: string;
  version: number;
  connectionVersion: number;
  connectionGeneration: string;
  values: Record<string, string>;
}

/* The envelope's additional data binds it to this connection and version, so
   a row copied onto another connection or rolled back does not decrypt. */
function envelopeOwner(connectionId: string): string {
  return `app-connection:${connectionId}`;
}

const ENVELOPE_REF = "credentials";

async function advanceCredentialConnection(tx: DatabaseTransaction, connectionId: string, at: string, installed: boolean) {
  // Human edits also advance the connection revision, fencing the empty->write->clear ABA case.
  await tx.query({ name: "app_credential_connection_advance_v1", text: `UPDATE data.app_connector_connections
    SET version=version+1,updated_at=$2,status=CASE WHEN $3 THEN 'configured' ELSE status END,
      last_checked_at=CASE WHEN $3 THEN $2 ELSE last_checked_at END,
      error=CASE WHEN $3 THEN NULL ELSE error END WHERE connection_id=$1`,
  values: [connectionId, new Date(at).toISOString(), installed], maxRows: 0 });
}

async function requireSpaceAdmin(tx: DatabaseTransaction, spaceId: string, userId: string): Promise<void> {
  const role = await tx.query<QueryResultRow>({ name: "app_credential_role_v2", text: `SELECT role
    FROM data.space_members WHERE space_id=$1 AND user_id=$2
      AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=$1)
    LIMIT 1 FOR SHARE`, values: [spaceId, userId], maxRows: 1 });
  if (role[0]?.role !== "owner" && role[0]?.role !== "admin") {
    throw new AppControlError("space_not_found", 404, "Space not found");
  }
}

async function decryptValues(material: string, row: QueryResultRow): Promise<Record<string, string>> {
  const plaintext = await decryptSecretValue(material, {
    encrypted_value_json: row.encrypted_value_json,
    owner_user_id: envelopeOwner(String(row.connection_id)),
    secret_ref: ENVELOPE_REF,
    authority_version: row.version,
  });
  const parsed = JSON.parse(plaintext) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppControlError("credential_corrupt", 409, "Connector credential envelope is invalid");
  }
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function readInstallationSnapshot(tx: DatabaseTransaction, spaceId: string, providerId = "sentry") {
  // Lock the connection before reading its credential version: a joined snapshot
  // can have observed the old grant while waiting for a concurrent writer.
  const rows = await tx.query<QueryResultRow>({ name: "app_installation_snapshot_connection_v1", text: `SELECT
    version,search_rank_sequence FROM data.app_connector_connections WHERE connection_id=$1 FOR UPDATE`,
  values: [`${spaceId}:${providerId}`], maxRows: 1 });
  if (!rows[0]) throw new AppControlError("app_connection_not_found", 404, "App connection not found");
  const credentials = await tx.query<QueryResultRow>({ name: "app_installation_snapshot_credentials_v1", text: `SELECT
    version FROM data.app_connector_credentials WHERE connection_id=$1 FOR UPDATE`,
  values: [`${spaceId}:${providerId}`], maxRows: 1 });
  return { connectionVersion: Number(rows[0].version), credentialVersion: Number(credentials[0]?.version ?? 0),
    connectionGeneration: String(rows[0].search_rank_sequence) };
}

export class PostgresAppCredentialRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {
    if (database.cacheMode !== "disabled") throw new AppControlError(
      "cached_authority_forbidden", 500, "App credential authority requires uncached PostgreSQL");
    if (!material) throw new AppControlError("credential_unavailable", 503,
      "Connector credential encryption is not configured");
  }

  /**
   * Writes the given fields over the current ones. A field set to `null` is
   * removed; fields not named keep their value. Returns field names only.
   */
  async put(input: { requestId: string; spaceId: string; providerId: string; actorUserId: string;
    fields: Record<string, string | null>; policy: AppCredentialFieldPolicy; at: string;
    oauthInstallation?: AppOAuthInstallation;
    /** Minted by the callback; existing ingress keys are preserved under the row lock. */
    initialize?: Record<string, string>;
    /** Refreshes must still be updating the grant they read before the provider request. */
    expectedVersion?: number;
    /** Discord callback commits only to the unchanged snapshot signed at initiation. */
    expectedInstallationSnapshot?: { connectionVersion: number; credentialVersion: number; connectionGeneration: string };
    /** A verified native installation replaces its grant and activates under both original versions. */
    verifiedInstallation?: { connectionVersion: number; credentialVersion: number; connectionGeneration: string; attemptId: string };
    /**
     * The Hub's own write of values it obtained for the connection (an OAuth
     * token refresh): no Space role check, recorded as `actorUserId`.
     */
    asHub?: boolean }) {
    const spaceId = text(input.spaceId, "spaceId");
    const providerId = text(input.providerId, "providerId", 80).toLowerCase();
    const actorUserId = text(input.actorUserId, "actorUserId");
    const entries = Object.entries(input.fields ?? {});
    if (entries.length === 0 || entries.length > MAX_FIELDS) throw new AppControlError(
      "invalid_app_request", 400, "fields is invalid");
    for (const [name, value] of [...entries, ...Object.entries(input.initialize ?? {})]) {
      if (!FIELD_NAME.test(name) || !input.policy.allowed.includes(name)) throw new AppControlError(
        "invalid_app_request", 400, "Unsupported connector credential field");
      if (value !== null && (typeof value !== "string" || !value || utf8ByteLength(value) > MAX_VALUE_BYTES)) {
        throw new AppControlError("invalid_app_request", 400, `${name} is invalid`);
      }
    }
    const installation = input.oauthInstallation;
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
    if (installation && (input.asHub || !["slack", "linear", "vercel", "sentry", "discord"].includes(providerId) ||
        !/^[A-Za-z0-9._-]{1,256}$/u.test(installation.appClientId) ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(installation.installationId) ||
        (providerId === "vercel" ? !/^icfg_[A-Za-z0-9]{1,80}$/u.test(installation.installationId) ||
          !/^(team|user)_[A-Za-z0-9_-]{1,80}$/u.test(installation.eventScopeId ?? "") :
          providerId === "sentry" ? !uuid.test(installation.installationId) || !uuid.test(installation.eventScopeId ?? "") :
          providerId === "discord" ? !/^[1-9][0-9]{14,24}$/u.test(installation.appClientId) ||
            !/^[1-9][0-9]{14,24}$/u.test(installation.installationId) ||
            !/^[1-9][0-9]{14,24}$/u.test(installation.eventScopeId ?? "") ||
            !Number.isFinite(Date.parse(installation.discordAuthorizedAt ?? "")) : installation.eventScopeId !== undefined))) {
      throw new AppControlError("invalid_app_request", 400, "Invalid OAuth installation");
    }
    const expected = input.expectedInstallationSnapshot;
    if (providerId === "discord" && !input.asHub && input.fields.oauthGuildId && !expected) {
      throw new AppControlError("invalid_app_request", 400, "Discord installation needs its original snapshot");
    }
    if (expected && (input.asHub || providerId !== "discord" || !Number.isSafeInteger(expected.connectionVersion) ||
        expected.connectionVersion < 1 || !Number.isSafeInteger(expected.credentialVersion) || expected.credentialVersion < 0 ||
        typeof expected.connectionGeneration !== "string" || !expected.connectionGeneration || expected.connectionGeneration.length > 1024 ||
        !["oauthClientId", "oauthGuildId", "oauthUserId"].every(key => /^[1-9][0-9]{14,24}$/u.test(input.fields[key] ?? "")) ||
        !input.fields.oauthToken || !input.fields.oauthRefreshToken || input.fields.botToken !== null)) {
      throw new AppControlError("invalid_app_request", 400, "Invalid Discord installation snapshot");
    }
    if (providerId === "discord" && installation && (!expected || installation.appClientId !== input.fields.oauthClientId ||
        installation.installationId !== input.fields.oauthGuildId || installation.eventScopeId !== input.fields.oauthUserId)) {
      throw new AppControlError("invalid_app_request", 400, "Discord binding does not match the verified grant");
    }
    const verified = input.verifiedInstallation;
    if ((providerId === "sentry" && installation && !verified) || (verified && (input.asHub || !installation ||
        providerId !== "sentry" || !uuid.test(verified.attemptId ?? "") || typeof verified.connectionGeneration !== "string" || !verified.connectionGeneration ||
        verified.connectionGeneration.length > 1_024 || !Number.isSafeInteger(verified.connectionVersion) || verified.connectionVersion < 1 ||
        !Number.isSafeInteger(verified.credentialVersion) || verified.credentialVersion < 0 ||
        input.fields.oauthClientId !== installation.appClientId || input.fields.oauthInstallationId !== installation.installationId ||
        input.fields.oauthAppUuid !== installation.eventScopeId ||
        !input.fields.oauthToken || !input.fields.oauthRefreshToken ||
        input.fields.oauthToken === input.fields.oauthRefreshToken ||
        !/^[1-9][0-9]{0,31}$/u.test(input.fields.oauthOrganizationId ?? "") ||
        !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(input.fields.oauthOrganization ?? "") ||
        !/^[a-z0-9][a-z0-9_-]{0,99}$/u.test(input.fields.oauthAppSlug ?? "") ||
        input.fields.oauthScopes !== SENTRY_PUBLIC_INTEGRATION_SCOPES.join(" ") ||
        !/^[1-9][0-9]{0,15}$/u.test(input.fields.oauthExpiresAt ?? "") ||
        !Number.isSafeInteger(Number(input.fields.oauthExpiresAt))))) {
      throw new AppControlError("invalid_app_request", 400, "Invalid verified installation");
    }
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.credentials.put" }, async (tx) => {
      if (!input.asHub) await requireSpaceAdmin(tx, spaceId, actorUserId);
      if (providerId === "discord" && installation) await lockDiscordInstallation(tx, installation, `${spaceId}:discord`);
      if (verified) await lockSentryAttempt(tx, installation!, spaceId, verified.attemptId, String(input.fields.oauthExpiresAt));
      const connectionId = `${spaceId}:${providerId}`;
      const connections = await tx.query<QueryResultRow>({ name: "app_credential_connection_v2", text: `SELECT
        connection_id,version,search_rank_sequence FROM data.app_connector_connections WHERE connection_id=$1 FOR UPDATE`,
      values: [connectionId], maxRows: 1 });
      if (!connections[0]) throw new AppControlError("app_connection_not_found", 404, "App connection not found");
      const rows = await tx.query<QueryResultRow>({ name: "app_credential_lock_v1", text: `SELECT *
        FROM data.app_connector_credentials WHERE connection_id=$1 FOR UPDATE`,
      values: [connectionId], maxRows: 1 });
      const current = rows[0];
      if (expected && (Number(connections[0].version) !== expected.connectionVersion ||
          Number(current?.version ?? 0) !== expected.credentialVersion || String(connections[0].search_rank_sequence) !== expected.connectionGeneration)) {
        throw new AppControlError("credential_changed", 409, "Discord connection changed during installation", true);
      }
      if (verified && (Number(connections[0].version) !== verified.connectionVersion ||
          Number(current?.version ?? 0) !== verified.credentialVersion ||
          String(connections[0].search_rank_sequence) !== verified.connectionGeneration)) {
        throw new AppControlError("credential_changed", 409, "Sentry connection changed during installation", true);
      }
      if (input.asHub && (!Number.isSafeInteger(input.expectedVersion) ||
          input.expectedVersion !== Number(current?.version))) {
        throw new AppControlError("credential_changed", 409, "Connector credentials changed during refresh", true);
      }
      // Native installation is an explicit replacement, never a fallback to old manual credentials.
      const values = current && !verified && !expected ? await decryptValues(this.material, current) : {};
      for (const [name, value] of Object.entries(input.initialize ?? {})) {
        if (!values[name]) values[name] = value;
      }
      if (providerId === "discord" && !input.asHub && !expected && Object.hasOwn(input.fields, "botToken")) {
        for (const field of ["oauthToken", "oauthRefreshToken", "oauthExpiresAt", "oauthClientId", "oauthGuildId", "oauthUserId", "oauthScopes"]) delete values[field];
      }
      for (const [name, value] of entries) {
        if (value === null) delete values[name];
        else values[name] = value;
      }
      const names = Object.keys(values).sort();
      if (names.length > MAX_FIELDS) throw new AppControlError("invalid_app_request", 400, "Too many credential fields");
      // Human credential edits replace the credential evidence for the binding.
      // A server refresh preserves it; a new grant replaces it atomically.
      if (!input.asHub || names.length === 0) {
        if (providerId === "wecom") {
          await tx.query({ name: "wecom_manual_installation_replace_v1", text: `DELETE FROM data.app_wecom_installations WHERE connection_id=$1`, values: [connectionId], maxRows: 0 });
          await tx.query({ name: "wecom_manual_attempt_replace_v1", text: `DELETE FROM data.app_wecom_install_attempts WHERE connection_id=$1`, values: [connectionId], maxRows: 0 });
        }
        if (providerId === "googlechat" || providerId === "feishu" || providerId === "telegram" || providerId === "teams") {
          const roomProvider = providerId;
          // A deliberate manual credential edit replaces native mode, never a fallback.
          await tx.query({ name: `app_${roomProvider}_manual_replace_v1`, text: `DELETE FROM
            data.app_${roomProvider}_room_bindings WHERE connection_id=$1`, values: [connectionId], maxRows: 0 });
          await tx.query({ name: `app_${roomProvider}_attempt_clear_v1`, text: `DELETE FROM
            data.app_${roomProvider}_link_attempts WHERE connection_id=$1`, values: [connectionId], maxRows: 0 });
        }
        await tx.query({ name: "app_oauth_installation_clear_v1", text: `DELETE FROM
          data.app_connector_oauth_installations WHERE connection_id=$1`, values: [connectionId], maxRows: 0 });
      }
      if (names.length === 0) {
        await tx.query({ name: "app_credential_clear_v1", text: `DELETE FROM data.app_connector_credentials
          WHERE connection_id=$1`, values: [connectionId], maxRows: 0 });
        await advanceCredentialConnection(tx, connectionId, input.at, false);
        return { connectionId, credentialFields: [] as string[] };
      }
      const version = Number(current?.version ?? 0) + 1;
      const envelope = await encryptSecretValue(this.material, envelopeOwner(connectionId), ENVELOPE_REF,
        version, JSON.stringify(values));
      await tx.query({ name: "app_credential_upsert_v1", text: `INSERT INTO data.app_connector_credentials
        (connection_id,space_id,field_names_json,encrypted_value_json,version,updated_by,created_at,updated_at)
        VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$7)
        ON CONFLICT (connection_id) DO UPDATE SET field_names_json=EXCLUDED.field_names_json,
          encrypted_value_json=EXCLUDED.encrypted_value_json,version=EXCLUDED.version,
          updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
      values: [connectionId, spaceId, JSON.stringify(names), JSON.stringify(envelope), version, actorUserId,
        new Date(input.at).toISOString()], maxRows: 0 });
      if (installation) {
        await tx.query({ name: "app_oauth_installation_bind_v3", text: `INSERT INTO
          data.app_connector_oauth_installations
          (connection_id,space_id,provider_id,app_client_id,installation_id,credential_version,updated_at,event_scope_id,grant_generation,discord_authorized_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,gen_random_uuid(),$9)`, values: [connectionId, spaceId, providerId,
          installation.appClientId, installation.installationId, version, new Date(input.at).toISOString(),
          installation.eventScopeId ?? null, installation.discordAuthorizedAt ?? null], maxRows: 0 });
      } else if (input.asHub) {
        await tx.query({ name: "app_oauth_installation_refresh_v1", text: `UPDATE
          data.app_connector_oauth_installations SET credential_version=$2,updated_at=$3
          WHERE connection_id=$1`, values: [connectionId, version, new Date(input.at).toISOString()], maxRows: 0 });
      }
      if (verified) await consumeSentryAttempt(tx, installation!);
      if (!input.asHub) await advanceCredentialConnection(tx, connectionId, input.at, !!verified);
      return { connectionId, credentialFields: names };
    });
  }

  /** Read only original versions after live admin authorization; no grant enters the browser. */
  async installationSnapshot(input: { requestId: string; spaceId: string; actorUserId: string; providerId?: "discord" }) {
    const spaceId = text(input.spaceId, "spaceId");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.credentials.installation-snapshot" }, async tx => {
      await requireSpaceAdmin(tx, spaceId, text(input.actorUserId, "actorUserId"));
      return readInstallationSnapshot(tx, spaceId, input.providerId ?? "sentry");
    });
  }

  /** Current owner/admin starts a single-use server attempt before provider exchange. */
  async beginSentryInstallation(input: { requestId: string; spaceId: string; actorUserId: string;
    installation: AppOAuthInstallation }) {
    const spaceId = text(input.spaceId, "spaceId");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.sentry-installation-begin" }, async tx => {
      await requireSpaceAdmin(tx, spaceId, text(input.actorUserId, "actorUserId"));
      const attemptId = await beginSentryAttempt(tx, input.installation, spaceId);
      return { ...await readInstallationSnapshot(tx, spaceId), attemptId };
    });
  }

  /** Called only for a signature-verified Sentry installation.deleted body. */
  async retireSentryInstallation(input: { requestId: string; appClientId: string; appUuid: string;
    installationId: string; at: string; limit: number }): Promise<number> {
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
    if (!uuid.test(input.appUuid) || !uuid.test(input.installationId) || !Number.isSafeInteger(input.limit) ||
        input.limit < 1 || input.limit > 50) throw new AppControlError("invalid_app_request", 400, "Invalid Sentry retirement");
    const clientId = text(input.appClientId, "appClientId", 256);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.sentry-installation-retire" }, async tx => {
      await retireSentryAttempt(tx, { appClientId: clientId, eventScopeId: input.appUuid, installationId: input.installationId });
      const targets = await tx.query<QueryResultRow>({ name: "app_sentry_retirement_lock_v1", text: `SELECT
        c.connection_id FROM data.app_connector_connections c
        JOIN data.app_connector_oauth_installations i ON i.connection_id=c.connection_id AND i.space_id=c.space_id
        JOIN data.app_connector_credentials k ON k.connection_id=c.connection_id AND k.space_id=c.space_id
          AND k.version=i.credential_version
        WHERE i.provider_id='sentry' AND i.app_client_id=$1 AND i.event_scope_id=$2 AND i.installation_id=$3
        ORDER BY c.connection_id LIMIT $4 FOR UPDATE OF c,k,i`,
      values: [clientId, input.appUuid, input.installationId, input.limit + 1], maxRows: input.limit + 1 });
      if (targets.length > input.limit) throw new AppControlError("too_many_installations", 503, "Sentry retirement exceeds its bound", true);
      const ids = targets.map(row => String(row.connection_id));
      if (!ids.length) return 0;
      await tx.query({ name: "app_sentry_retire_credentials_v1", text: `DELETE FROM data.app_connector_credentials
        WHERE connection_id=ANY($1::text[])`, values: [ids], maxRows: 0 });
      await tx.query({ name: "app_sentry_retire_binding_v1", text: `DELETE FROM data.app_connector_oauth_installations
        WHERE connection_id=ANY($1::text[])`, values: [ids], maxRows: 0 });
      await tx.query({ name: "app_sentry_retire_connection_v1", text: `UPDATE data.app_connector_connections
        SET status='disconnected',error=NULL,version=version+1,updated_at=$2 WHERE connection_id=ANY($1::text[])`,
      values: [ids, new Date(input.at).toISOString()], maxRows: 0 });
      return ids.length;
    });
  }

  /**
   * Values for a Space admin to read back: only the fields the manifest marks
   * `generated` (the Hub minted them for the admin to paste into the provider).
   */
  async readGenerated(input: { requestId: string; spaceId: string; providerId: string; actorUserId: string;
    generated: readonly string[] }): Promise<Record<string, string>> {
    const spaceId = text(input.spaceId, "spaceId");
    const providerId = text(input.providerId, "providerId", 80).toLowerCase();
    const actorUserId = text(input.actorUserId, "actorUserId");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.credentials.read-generated" }, async (tx) => {
      await requireSpaceAdmin(tx, spaceId, actorUserId);
      const rows = await tx.query<QueryResultRow>({ name: "app_credential_read_v1", text: `SELECT *
        FROM data.app_connector_credentials WHERE connection_id=$1 LIMIT 1`,
      values: [`${spaceId}:${providerId}`], maxRows: 1 });
      if (!rows[0]) return {};
      const values = await decryptValues(this.material, rows[0]);
      return Object.fromEntries(Object.entries(values).filter(([name]) => input.generated.includes(name)));
    });
  }

  /**
   * The Hub's own read for event ingress and action execution: no principal,
   * so callers must be a trusted server boundary that authenticates the
   * request some other way (an ingress key, an authorized execution).
   */
  async resolve(input: { requestId: string; spaceId: string; providerId: string }):
    Promise<ResolvedAppCredentials | null> {
    const spaceId = text(input.spaceId, "spaceId");
    const providerId = text(input.providerId, "providerId", 80).toLowerCase();
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200),
      operation: "app.credentials.resolve" }, async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "app_credential_resolve_v1", text: `SELECT
        k.*,c.status,c.created_by,c.provider_id,c.version AS connection_version,c.search_rank_sequence FROM data.app_connector_credentials k
        JOIN data.app_connector_connections c ON c.connection_id=k.connection_id AND c.space_id=k.space_id
        WHERE k.connection_id=$1 AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=k.space_id) LIMIT 1`, values: [`${spaceId}:${providerId}`], maxRows: 1 });
      const row = rows[0];
      if (!row) return null;
      return { connectionId: String(row.connection_id), spaceId: String(row.space_id),
        providerId: String(row.provider_id), status: String(row.status), createdBy: String(row.created_by),
        version: Number(row.version), connectionVersion: Number(row.connection_version),
        connectionGeneration: String(row.search_rank_sequence), values: await decryptValues(this.material, row) };
    });
  }
}
