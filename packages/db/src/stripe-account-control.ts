import type { QueryResultRow } from "pg";
import type { StripeAccountView, StripeAccountPage } from "@xmatrix/protocol";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";
import { requireCredentialAdmin } from "./app-credential-admin.js";
import { encryptSecretValue, decryptSecretValue } from "./secret-value-control.js";
import { STRIPE_NATIVE_GRANT_SQL } from "./stripe-account-routing.js";

const ACCOUNT = /^acct_[A-Za-z0-9]{1,64}$/u;
const CLIENT = /^ca_[A-Za-z0-9]+$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const PAGE = 50;
const fail = (message: string) => new AppControlError("credential_changed", 409, message, true);

export interface StripeAccountGrant {
  accountId: string;
  appClientId: string;
  generation: string;
  name: string;
  authorizedAt: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
export interface StripeAccountSnapshot { connectionVersion: number; connectionGeneration: string }
export interface StripeRefreshClaim {
  grant: StripeAccountGrant; version: number; lease: string | null;
}

function accountId(value: string): string {
  if (!ACCOUNT.test(value)) throw new AppControlError("invalid_app_request", 400, "Invalid Stripe account");
  return value;
}
function clientId(value: string): string {
  if (!CLIENT.test(value)) throw new AppControlError("invalid_app_request", 400, "Invalid Stripe application");
  return value;
}
function checkedGrant(grant: StripeAccountGrant): StripeAccountGrant {
  accountId(grant.accountId); clientId(grant.appClientId);
  if (!UUID.test(grant.generation) || !grant.name || grant.name.length > 200 ||
      !Number.isFinite(Date.parse(grant.authorizedAt)) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0 ||
      ![grant.accessToken, grant.refreshToken].every(token => typeof token === "string" && token.length > 0 && token.length <= 4096) ||
      grant.accessToken === grant.refreshToken) throw new AppControlError("invalid_app_request", 400, "Incomplete Stripe grant");
  return grant;
}
const owner = (connectionId: string, id: string) => `stripe-account:${connectionId}:${id}`;
const view = (row: QueryResultRow): StripeAccountView => ({ id: String(row.account_id), name: String(row.display_name),
  generation: String(row.grant_generation), status: row.status === "active" ? "active" : "reconnect",
  connectedBy: String(row.connected_by), connectedAt: new Date(row.authorized_at).toISOString() });

/** Parent locks precede account locks in every mutation, including revocation. */
async function lockConnection(tx: DatabaseTransaction, spaceId: string) {
  const rows = await tx.query<QueryResultRow>({ name: "stripe_parent_lock_v1", text: `SELECT version,search_rank_sequence,status
    FROM data.app_connector_connections WHERE connection_id=$1 AND space_id=$2 AND provider_id='stripe'
      AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=$2) FOR UPDATE`,
  values: [`${spaceId}:stripe`, spaceId], maxRows: 1 });
  if (!rows[0]) throw new AppControlError("app_connection_not_found", 404, "Stripe connection not found");
  return rows[0];
}
async function projectStatus(tx: DatabaseTransaction, connectionId: string, at: string,
  { advance = true, checked = false }: { advance?: boolean; checked?: boolean } = {}) {
  await tx.query({ name: "stripe_parent_project_v3", text: `UPDATE data.app_connector_connections c
    SET status=CASE WHEN EXISTS (SELECT 1 FROM data.app_stripe_account_grants a
      WHERE a.connection_id=c.connection_id AND a.status='active') THEN 'configured' ELSE 'disconnected' END,
      version=version+CASE WHEN $3 THEN 1 ELSE 0 END,updated_at=GREATEST(created_at,updated_at,$2::timestamptz),error=NULL,
      last_checked_at=CASE WHEN $4 THEN GREATEST(created_at,$2::timestamptz) ELSE last_checked_at END WHERE connection_id=$1`,
  values: [connectionId, at, advance, checked], maxRows: 0 });
}

/** One merchant's grant cannot replace, refresh or retire another merchant's grant. */
export class PostgresStripeAccountRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {}

  /** Explicit one-way cutover from a provider-authenticated legacy row, never a routing fallback. */
  private async adoptLegacy(tx: DatabaseTransaction, spaceId: string, parent: QueryResultRow) {
    const connectionId = `${spaceId}:stripe`;
    const legacy = (await tx.query<QueryResultRow>({ name: "stripe_legacy_grant_lock_v1", text: `SELECT k.*,
      i.installation_id AS account_id,i.app_client_id,i.updated_at AS authorized_at,
      COALESCE(i.grant_generation,gen_random_uuid()) AS grant_generation,c.created_by AS connected_by
      FROM data.app_connector_oauth_installations i JOIN data.app_connector_credentials k
        ON k.connection_id=i.connection_id AND k.space_id=i.space_id AND k.version=i.credential_version
      JOIN data.app_connector_connections c ON c.connection_id=i.connection_id AND c.space_id=i.space_id
      WHERE i.connection_id=$1 AND i.provider_id='stripe' FOR UPDATE OF i,k`,
    values: [connectionId], maxRows: 1 }))[0];
    if (legacy) {
      const migrated = { ...legacy, credential_version: legacy.version, envelope_kind: "connection", display_name: legacy.account_id };
      await this.decrypt(migrated);
      await tx.query({ name: "stripe_legacy_adopt_v1", text: `INSERT INTO data.app_stripe_account_grants
        (connection_id,space_id,account_id,app_client_id,display_name,grant_generation,authorized_at,connected_by,
          status,credential_version,envelope_kind,encrypted_value_json,updated_at,legacy_pending)
        VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$8,$9,'connection',$10::jsonb,$6,false)
        ON CONFLICT (connection_id,account_id) DO UPDATE SET app_client_id=EXCLUDED.app_client_id,
          grant_generation=EXCLUDED.grant_generation,authorized_at=EXCLUDED.authorized_at,
          status=EXCLUDED.status,credential_version=EXCLUDED.credential_version,
          encrypted_value_json=EXCLUDED.encrypted_value_json,updated_at=EXCLUDED.updated_at,legacy_pending=false
        WHERE app_stripe_account_grants.legacy_pending`, values: [connectionId, spaceId, legacy.account_id,
        legacy.app_client_id, legacy.grant_generation, legacy.authorized_at, legacy.connected_by,
        parent.status === "disconnected" ? "reconnect" : "active", Number(legacy.version), JSON.stringify(legacy.encrypted_value_json)], maxRows: 0 });
      await tx.query({ name: "stripe_legacy_credentials_retire_v1", text: `DELETE FROM data.app_connector_credentials
        WHERE connection_id=$1 AND version=$2`, values: [connectionId, Number(legacy.version)], maxRows: 0 });
      await tx.query({ name: "stripe_legacy_binding_retire_v1", text: `DELETE FROM data.app_connector_oauth_installations
        WHERE connection_id=$1 AND provider_id='stripe'`, values: [connectionId], maxRows: 0 });
    }
    // A manual edit during the old Hub's drain can retire a copied binding;
    // only pending copies are removed, never an account accepted by the new Hub.
    await tx.query({ name: "stripe_legacy_obsolete_copy_v1", text: `DELETE FROM data.app_stripe_account_grants
      WHERE connection_id=$1 AND legacy_pending`, values: [connectionId], maxRows: 0 });
  }

  private async adoptSpace(spaceId: string) {
    await this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.adopt" }, async tx => {
      const parent = await lockConnection(tx, spaceId);
      await this.adoptLegacy(tx, spaceId, parent);
    });
  }

  private async decrypt(row: QueryResultRow): Promise<StripeAccountGrant> {
    const connectionId = String(row.connection_id), id = String(row.account_id);
    const value: unknown = JSON.parse(await decryptSecretValue(this.material, { encrypted_value_json: row.encrypted_value_json,
      owner_user_id: row.envelope_kind === "connection" ? `app-connection:${connectionId}` : owner(connectionId, id),
      secret_ref: "credentials", authority_version: row.credential_version }));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("Stripe credential envelope is invalid");
    const fields = value as Record<string, unknown>;
    if (typeof fields.oauthToken !== "string" || typeof fields.oauthRefreshToken !== "string" ||
        (row.envelope_kind === "connection" && fields.stripeUserId !== id)) throw fail("Stripe grant identity does not match its account");
    return checkedGrant({ accountId: id, appClientId: String(row.app_client_id), generation: String(row.grant_generation),
      name: String(row.display_name), authorizedAt: new Date(row.authorized_at).toISOString(),
      accessToken: fields.oauthToken, refreshToken: fields.oauthRefreshToken, expiresAt: Number(fields.oauthExpiresAt) });
  }

  /** Current admin authority is checked before exposing even merchant metadata. */
  async list(input: { spaceId: string; actorUserId: string; after?: string }): Promise<StripeAccountPage> {
    const spaceId = text(input.spaceId, "spaceId"), actor = text(input.actorUserId, "actorUserId");
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.list" }, async tx => {
      await requireCredentialAdmin(tx, spaceId, actor);
      const parents = await tx.query<QueryResultRow>({ name: "stripe_list_parent_v1", text: `SELECT version,status,search_rank_sequence
        FROM data.app_connector_connections WHERE connection_id=$1 FOR UPDATE`, values: [`${spaceId}:stripe`], maxRows: 1 });
      if (parents[0]) await this.adoptLegacy(tx, spaceId, parents[0]);
      const rows = await tx.query<QueryResultRow>({ name: "stripe_account_list_v1", text: `SELECT account_id,display_name,
        grant_generation,CASE WHEN refresh_started_at<clock_timestamp()-interval '30 seconds' THEN 'reconnect' ELSE status END AS status,
        connected_by,authorized_at FROM data.app_stripe_account_grants
        WHERE connection_id=$1 AND ($2::text IS NULL OR account_id>$2) ORDER BY account_id LIMIT $3`,
      values: [`${spaceId}:stripe`, input.after === undefined ? null : accountId(input.after), PAGE + 1], maxRows: PAGE + 1 });
      return { accounts: rows.slice(0, PAGE).map(view), after: rows.length > PAGE ? String(rows[PAGE - 1]!.account_id) : null };
    });
  }

  /** Account ids only; the Hub checks individual grants without exposing tokens. */
  async activeAccounts(spaceId: string, after?: string): Promise<string[]> {
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.active" }, tx =>
      tx.query<QueryResultRow>({ name: "stripe_account_active_v1", text: `SELECT a.account_id FROM data.app_stripe_account_grants a
        JOIN data.app_connector_connections c ON ${STRIPE_NATIVE_GRANT_SQL}
        WHERE a.connection_id=$1 AND c.status<>'disconnected' AND ($2::text IS NULL OR a.account_id>$2)
          AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=a.space_id)
        ORDER BY a.account_id LIMIT $3`, values: [`${text(spaceId, "spaceId")}:stripe`, after ?? null, PAGE], maxRows: PAGE })
        .then(rows => rows.map(row => String(row.account_id))));
  }

  async hasAccounts(spaceId: string): Promise<boolean> {
    await this.adoptSpace(spaceId);
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.present" }, async tx => {
      const rows = await tx.query({ name: "stripe_accounts_present_v1", text: `SELECT 1 FROM data.app_stripe_account_grants
        WHERE connection_id=$1 LIMIT 1`, values: [`${text(spaceId, "spaceId")}:stripe`], maxRows: 1 });
      return rows.length > 0;
    });
  }

  private async adoptAccount(client: string, id: string, limit: number) {
    const pending = await this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.adopt-candidates" }, tx =>
      tx.query<QueryResultRow>({ name: "stripe_legacy_event_candidates_v1", text: `SELECT DISTINCT space_id FROM (
        SELECT space_id FROM data.app_connector_oauth_installations WHERE provider_id='stripe' AND app_client_id=$1 AND installation_id=$2
        UNION SELECT space_id FROM data.app_stripe_account_grants WHERE legacy_pending AND app_client_id=$1 AND account_id=$2) candidate
        WHERE NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=candidate.space_id)
        ORDER BY space_id LIMIT $3`, values: [client, id, limit + 1], maxRows: limit + 1 }));
    if (pending.length > limit) throw new AppControlError("too_many_installations", 503, "Stripe adoption exceeds its bound", true);
    for (const row of pending) await this.adoptSpace(String(row.space_id));
  }

  /** The signed account chooses its current Space bindings; nothing routes from a login or a name. */
  async eventConnections(input: { appClientId: string; accountId: string; limit: number }) {
    const id = accountId(input.accountId), client = clientId(input.appClientId);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw fail("Invalid Stripe routing bound");
    await this.adoptAccount(client, id, input.limit);
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.event-connections" }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "stripe_account_event_connections_v1", text: `SELECT a.connection_id,
        a.space_id,a.credential_version,a.grant_generation FROM data.app_stripe_account_grants a
        JOIN data.app_connector_connections c ON ${STRIPE_NATIVE_GRANT_SQL}
        WHERE a.app_client_id=$1 AND a.account_id=$2 AND c.status='configured'
          AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=a.space_id)
        ORDER BY a.connection_id LIMIT $3`, values: [client, id, input.limit + 1], maxRows: input.limit + 1 });
      if (rows.length > input.limit) throw new AppControlError("too_many_installations", 503, "Stripe routing exceeds its bound", true);
      return rows.map(row => ({ connectionId: String(row.connection_id), spaceId: String(row.space_id),
        credentialVersion: Number(row.credential_version), grantGeneration: String(row.grant_generation) }));
    });
  }

  /** Stripe timestamps have second precision; ambiguous same-second revocations fail closed. */
  async retireAccount(input: { appClientId: string; accountId: string; eventAt: string; limit: number }) {
    const id = accountId(input.accountId), client = clientId(input.appClientId);
    if (!Number.isFinite(Date.parse(input.eventAt)) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw fail("Invalid Stripe revocation");
    }
    await this.adoptAccount(client, id, input.limit);
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.retire" }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "stripe_account_retire_lock_v1", text: `SELECT a.connection_id,a.space_id
        FROM data.app_stripe_account_grants a JOIN data.app_connector_connections c ON c.connection_id=a.connection_id
        WHERE a.app_client_id=$1 AND a.account_id=$2 AND a.status='active'
          AND date_trunc('second',a.authorized_at)<=$3::timestamptz
        ORDER BY a.connection_id LIMIT $4 FOR UPDATE OF c,a`,
      values: [client, id, input.eventAt, input.limit + 1], maxRows: input.limit + 1 });
      if (rows.length > input.limit) throw new AppControlError("too_many_installations", 503, "Stripe revocation exceeds its bound", true);
      const at = new Date().toISOString();
      for (const row of rows) {
        await tx.query({ name: "stripe_account_retire_v1", text: `UPDATE data.app_stripe_account_grants
          SET status='reconnect',encrypted_value_json=NULL,credential_version=credential_version+1,
            refresh_lease=NULL,refresh_started_at=NULL,expires_at=NULL,updated_at=$3
          WHERE connection_id=$1 AND account_id=$2`, values: [String(row.connection_id), id, at], maxRows: 0 });
        await projectStatus(tx, String(row.connection_id), at);
      }
      return rows.length;
    });
  }

  /** Only the authenticated OAuth completion supplies a provider-verified grant. */
  async connect(input: { spaceId: string; actorUserId: string; grant: StripeAccountGrant; snapshot: StripeAccountSnapshot }) {
    const spaceId = text(input.spaceId, "spaceId"), actor = text(input.actorUserId, "actorUserId");
    const grant = checkedGrant(input.grant), connectionId = `${spaceId}:stripe`, at = new Date().toISOString();
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.connect" }, async tx => {
      await requireCredentialAdmin(tx, spaceId, actor);
      const parent = await lockConnection(tx, spaceId);
      await this.adoptLegacy(tx, spaceId, parent);
      const current = (await tx.query<QueryResultRow>({ name: "stripe_account_connect_lock_v1", text: `SELECT *
        FROM data.app_stripe_account_grants WHERE connection_id=$1 AND account_id=$2 FOR UPDATE`,
      values: [connectionId, grant.accountId], maxRows: 1 }))[0];
      if (parent.status === "configured" && current?.status === "active" && current.grant_generation === grant.generation && current.app_client_id === grant.appClientId) {
        const kept = await this.decrypt(current);
        if (kept.accessToken === grant.accessToken && kept.refreshToken === grant.refreshToken) return;
      }
      if (String(parent.search_rank_sequence) !== input.snapshot.connectionGeneration ||
          Number(parent.version) !== input.snapshot.connectionVersion) throw fail("Stripe connection changed during authorization; restart Connect");
      if (parent.status === "disconnected") {
        // Also fence an old in-flight Hub's global Disconnect, which knew only the parent row.
        await tx.query({ name: "stripe_disconnected_parent_retire_v1", text: `UPDATE data.app_stripe_account_grants
          SET status='reconnect',encrypted_value_json=NULL,credential_version=credential_version+1,
            refresh_lease=NULL,refresh_started_at=NULL WHERE connection_id=$1 AND status='active'`, values: [connectionId], maxRows: 0 });
      }
      const version = Number(current?.credential_version ?? 0) + 1;
      const envelope = await encryptSecretValue(this.material, owner(connectionId, grant.accountId), "credentials", version,
        JSON.stringify({ oauthToken: grant.accessToken, oauthRefreshToken: grant.refreshToken, oauthExpiresAt: String(grant.expiresAt) }));
      // A deliberate native Connect replaces manual webhook mode, never merges its credentials.
      await tx.query({ name: "stripe_native_clear_manual_v1", text: `DELETE FROM data.app_connector_credentials WHERE connection_id=$1`,
        values: [connectionId], maxRows: 0 });
      await tx.query({ name: "stripe_account_connect_v1", text: `INSERT INTO data.app_stripe_account_grants
        (connection_id,space_id,account_id,app_client_id,display_name,grant_generation,authorized_at,connected_by,
          status,credential_version,envelope_kind,encrypted_value_json,expires_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,'account',$10::jsonb,$11,$12)
        ON CONFLICT (connection_id,account_id) DO UPDATE SET app_client_id=EXCLUDED.app_client_id,
          display_name=EXCLUDED.display_name,grant_generation=EXCLUDED.grant_generation,authorized_at=EXCLUDED.authorized_at,
          connected_by=EXCLUDED.connected_by,status='active',credential_version=EXCLUDED.credential_version,
          envelope_kind='account',encrypted_value_json=EXCLUDED.encrypted_value_json,expires_at=EXCLUDED.expires_at,
          refresh_lease=NULL,refresh_started_at=NULL,updated_at=EXCLUDED.updated_at`,
      values: [connectionId, spaceId, grant.accountId, grant.appClientId, grant.name, grant.generation, grant.authorizedAt,
        actor, version, JSON.stringify(envelope), new Date(grant.expiresAt).toISOString(), at], maxRows: 0 });
      await projectStatus(tx, connectionId, at, { checked: true });
    });
  }

  async remove(input: { spaceId: string; actorUserId: string; accountId: string; generation: string }) {
    const spaceId = text(input.spaceId, "spaceId"), id = accountId(input.accountId);
    if (!UUID.test(input.generation)) throw fail("Reload the Stripe account list");
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.remove" }, async tx => {
      await requireCredentialAdmin(tx, spaceId, text(input.actorUserId, "actorUserId"));
      await lockConnection(tx, spaceId);
      const removed = await tx.query({ name: "stripe_account_remove_v1", text: `DELETE FROM data.app_stripe_account_grants
        WHERE connection_id=$1 AND account_id=$2 AND grant_generation=$3 RETURNING account_id`,
      values: [`${spaceId}:stripe`, id, input.generation], maxRows: 1 });
      if (!removed.length) throw fail("The Stripe account changed; reload its account list");
      await projectStatus(tx, `${spaceId}:stripe`, new Date().toISOString());
    });
  }

  /** An authenticated provider refusal retires only the grant that made that request. */
  async rejectGrant(input: { spaceId: string; accountId: string; generation: string }) {
    const spaceId = text(input.spaceId, "spaceId"), id = accountId(input.accountId);
    if (!UUID.test(input.generation)) throw fail("Invalid Stripe grant generation");
    await this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.refused" }, async tx => {
      await lockConnection(tx, spaceId);
      const changed = await tx.query({ name: "stripe_account_refused_v1", text: `UPDATE data.app_stripe_account_grants
        SET status='reconnect',encrypted_value_json=NULL,credential_version=credential_version+1,
          refresh_lease=NULL,refresh_started_at=NULL,expires_at=NULL,updated_at=clock_timestamp()
        WHERE connection_id=$1 AND account_id=$2 AND grant_generation=$3 AND status='active' RETURNING account_id`,
      values: [`${spaceId}:stripe`, id, input.generation], maxRows: 1 });
      if (changed.length) await projectStatus(tx, `${spaceId}:stripe`, new Date().toISOString(), { advance: false });
    });
  }

  /** A durable lease is acquired before a rotating refresh token leaves the store. */
  async claimRefresh(input: { spaceId: string; accountId: string; appClientId: string }): Promise<StripeRefreshClaim> {
    const spaceId = text(input.spaceId, "spaceId"), id = accountId(input.accountId), appClientId = clientId(input.appClientId);
    const now = Date.now();
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.refresh-claim" }, async tx => {
      const parent = await lockConnection(tx, spaceId);
      await this.adoptLegacy(tx, spaceId, parent);
      const row = (await tx.query<QueryResultRow>({ name: "stripe_account_refresh_lock_v1", text: `SELECT *
        FROM data.app_stripe_account_grants WHERE connection_id=$1 AND account_id=$2 FOR UPDATE`,
      values: [`${spaceId}:stripe`, id], maxRows: 1 }))[0];
      if (parent.status === "disconnected" || !row || row.status !== "active" || row.app_client_id !== appClientId) {
        throw fail("Reconnect this Stripe account");
      }
      const grant = await this.decrypt(row), version = Number(row.credential_version);
      if (grant.expiresAt > now + 60_000) return { grant, version, lease: null };
      if (row.refresh_lease) throw new AppControlError("stripe_refresh_in_progress", 503,
        now - new Date(row.refresh_started_at).getTime() > 30_000
          ? "Stripe refresh could not be confirmed; reconnect this account" : "Stripe account is being refreshed; try again", true);
      const lease = crypto.randomUUID();
      await tx.query({ name: "stripe_account_refresh_claim_v1", text: `UPDATE data.app_stripe_account_grants
        SET refresh_lease=$3,refresh_started_at=$4 WHERE connection_id=$1 AND account_id=$2`,
      values: [`${spaceId}:stripe`, id, lease, new Date(now).toISOString()], maxRows: 0 });
      return { grant, version, lease };
    });
  }

  /** Commit only to the leased generation; removal or reconnection wins over a late response. */
  async finishRefresh(input: { spaceId: string; claim: StripeRefreshClaim; grant?: StripeAccountGrant }) {
    const spaceId = text(input.spaceId, "spaceId"), { claim } = input;
    if (!claim.lease || !UUID.test(claim.lease)) throw fail("Stripe refresh lease is missing");
    const old = checkedGrant(claim.grant), next = input.grant ? checkedGrant(input.grant) : undefined;
    if (next && (next.accountId !== old.accountId || next.appClientId !== old.appClientId || next.generation !== old.generation)) {
      throw fail("Stripe refreshed a different account");
    }
    return this.database.transaction({ requestId: crypto.randomUUID(), operation: "stripe.accounts.refresh-finish" }, async tx => {
      const parent = await lockConnection(tx, spaceId);
      if (parent.status === "disconnected") throw fail("Stripe connection was disconnected during refresh");
      const version = claim.version + 1, connectionId = `${spaceId}:stripe`;
      const current = (await tx.query<QueryResultRow>({ name: "stripe_account_refresh_finish_lock_v1", text: `SELECT *
        FROM data.app_stripe_account_grants WHERE connection_id=$1 AND account_id=$2 FOR UPDATE`,
      values: [connectionId, old.accountId], maxRows: 1 }))[0];
      // The exact new token proves a COMMIT whose acknowledgement was lost.
      if (current?.grant_generation === old.generation && Number(current.credential_version) === version && !current.refresh_lease) {
        if (!next && current.status === "reconnect") return;
        if (next && current.status === "active") {
          const kept = await this.decrypt(current);
          if (kept.accessToken === next.accessToken && kept.refreshToken === next.refreshToken && kept.expiresAt === next.expiresAt) return;
        }
      }
      const envelope = next ? await encryptSecretValue(this.material, owner(connectionId, old.accountId), "credentials", version,
        JSON.stringify({ oauthToken: next.accessToken, oauthRefreshToken: next.refreshToken, oauthExpiresAt: String(next.expiresAt) })) : null;
      const rows = await tx.query({ name: "stripe_account_refresh_finish_v1", text: `UPDATE data.app_stripe_account_grants
        SET encrypted_value_json=$6::jsonb,envelope_kind='account',credential_version=$7,
          expires_at=$8,status=$9,refresh_lease=NULL,refresh_started_at=NULL,updated_at=clock_timestamp()
        WHERE connection_id=$1 AND account_id=$2 AND grant_generation=$3 AND credential_version=$4 AND refresh_lease=$5
        RETURNING account_id`, values: [connectionId, old.accountId, old.generation, claim.version, claim.lease,
        envelope ? JSON.stringify(envelope) : null, version, next ? new Date(next.expiresAt).toISOString() : null,
        next ? "active" : "reconnect"], maxRows: 1 });
      if (!rows.length) throw fail("Stripe grant changed while refreshing");
      if (!next) await projectStatus(tx, connectionId, new Date().toISOString(), { advance: false });
    });
  }
}
