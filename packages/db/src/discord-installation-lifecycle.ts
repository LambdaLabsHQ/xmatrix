import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { AppOAuthInstallation } from "./app-credential-control.js";
import { AppControlError } from "./app-control.js";

const ID = /^[1-9][0-9]{14,24}$/u;
const LIMIT = 50;
function identity(appClientId: string, userId: string) {
  if (!ID.test(appClientId) || !ID.test(userId)) throw new AppControlError("invalid_app_request", 400, "Invalid Discord lifecycle identity");
}
async function lockUser(tx: DatabaseTransaction, appClientId: string, userId: string) {
  identity(appClientId, userId);
  // This precedes connection/credential locks on both installation and retirement.
  await tx.query({ name: "discord_lifecycle_user_lock_v1", text: `SELECT
    pg_advisory_xact_lock(hashtextextended($1,0))`, values: [`discord:${appClientId}:${userId}`], maxRows: 1 });
}
/** Called under the callback's transaction before any credential/connection lock. */
export async function lockDiscordInstallation(tx: DatabaseTransaction, installation: AppOAuthInstallation, connectionId: string) {
  await lockUser(tx, installation.appClientId, installation.eventScopeId!);
  const rows = await tx.query<QueryResultRow>({ name: "discord_installation_revocation_v1", text: `SELECT revoked_at
    FROM data.app_discord_revocations WHERE app_client_id=$1 AND user_id=$2 AND expires_at>statement_timestamp()`,
  values: [installation.appClientId, installation.eventScopeId], maxRows: 1 });
  if (rows[0] && new Date(rows[0].revoked_at).getTime() >= Date.parse(installation.discordAuthorizedAt!)) {
    throw new AppControlError("installation_revoked", 409, "Discord authorization was revoked; restart Connect");
  }
  const targets = await tx.query({ name: "discord_installation_capacity_v1", text: `SELECT connection_id
    FROM data.app_connector_oauth_installations WHERE provider_id='discord' AND app_client_id=$1
      AND event_scope_id=$2 ORDER BY connection_id LIMIT 51`, values: [installation.appClientId, installation.eventScopeId], maxRows: 51 });
  if (targets.length > LIMIT || (targets.length === LIMIT && !targets.some(row => row.connection_id === connectionId))) throw new AppControlError("too_many_installations", 503, "Discord installation capacity reached", true);
}

/** Only the dedicated Hub signature boundary invokes this authority. */
export class PostgresDiscordLifecycleRepository {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode !== "disabled") throw new AppControlError("cached_authority_forbidden", 500, "Discord lifecycle requires uncached PostgreSQL");
  }
  async receive(input: { requestId: string; appClientId: string; userId: string;
    type: "APPLICATION_AUTHORIZED" | "APPLICATION_DEAUTHORIZED"; eventAt: string; guildId?: string }) {
    identity(input.appClientId, input.userId);
    const eventAt = new Date(input.eventAt);
    if (!Number.isFinite(eventAt.getTime()) || !["APPLICATION_AUTHORIZED", "APPLICATION_DEAUTHORIZED"].includes(input.type) ||
        (input.type === "APPLICATION_AUTHORIZED" && !ID.test(input.guildId ?? ""))) {
      throw new AppControlError("invalid_app_request", 400, "Invalid Discord lifecycle event");
    }
    return this.database.transaction({ requestId: input.requestId, operation: "app.discord-lifecycle" }, async tx => {
      await lockUser(tx, input.appClientId, input.userId);
      if (input.type === "APPLICATION_DEAUTHORIZED") {
        // Serialize capacity and expiry cleanup; no cross-user row-lock cycle.
        await tx.query({ name: "discord_revocation_capacity_lock_v1", text: `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          values: [`discord-revocations:${input.appClientId}`], maxRows: 1 });
        await tx.query({ name: "discord_revocation_prune_v1", text: `DELETE FROM data.app_discord_revocations
          WHERE (app_client_id,user_id) IN (SELECT app_client_id,user_id FROM data.app_discord_revocations
            WHERE app_client_id=$1 AND expires_at<statement_timestamp() ORDER BY expires_at,user_id LIMIT 100 FOR UPDATE SKIP LOCKED)`,
        values: [input.appClientId], maxRows: 0 });
        // One count row: query results are capped at 10000 rows.
        const [capacity] = await tx.query<QueryResultRow>({ name: "discord_revocation_capacity_v2", text: `SELECT count(*)::int AS n,
          coalesce(bool_or(user_id=$2),false) AS present FROM (SELECT user_id FROM data.app_discord_revocations
          WHERE app_client_id=$1 LIMIT 10001) bounded`, values: [input.appClientId, input.userId], maxRows: 1 });
        if (Number(capacity?.n ?? 0) >= 10000 && capacity?.present !== true) {
          throw new AppControlError("storage_backpressure", 503, "Discord revocation capacity reached", true);
        }
        await tx.query({ name: "discord_revocation_record_v1", text: `INSERT INTO data.app_discord_revocations
          (app_client_id,user_id,revoked_at,expires_at) VALUES ($1,$2,$3,statement_timestamp()+interval '20 minutes')
          ON CONFLICT (app_client_id,user_id) DO UPDATE SET revoked_at=GREATEST(app_discord_revocations.revoked_at,EXCLUDED.revoked_at),
            expires_at=GREATEST(app_discord_revocations.expires_at,EXCLUDED.expires_at)`,
        values: [input.appClientId, input.userId, eventAt.toISOString()], maxRows: 0 });
      }
      // Lock connections first, then reread each binding/credential to avoid a
      // joined snapshot observed before waiting on a concurrent manual edit.
      const targets = await tx.query<QueryResultRow>({ name: "discord_lifecycle_targets_v1", text: `SELECT c.connection_id,c.space_id
        FROM data.app_connector_connections c JOIN data.app_connector_oauth_installations i
          ON i.connection_id=c.connection_id AND i.space_id=c.space_id
        WHERE c.provider_id='discord' AND i.provider_id='discord' AND i.app_client_id=$1 AND i.event_scope_id=$2
          AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=c.space_id)
        ORDER BY c.connection_id LIMIT 51 FOR UPDATE OF c`, values: [input.appClientId, input.userId], maxRows: 51 });
      if (targets.length > LIMIT) throw new AppControlError("too_many_installations", 503, "Discord lifecycle exceeds its bound", true);
      let matched = 0;
      for (const target of targets) {
        const current = await tx.query<QueryResultRow>({ name: "discord_lifecycle_current_v1", text: `SELECT i.installation_id
          FROM data.app_connector_oauth_installations i JOIN data.app_connector_credentials k
            ON k.connection_id=i.connection_id AND k.space_id=i.space_id AND k.version=i.credential_version
          JOIN data.app_connector_connections c ON c.connection_id=i.connection_id AND c.space_id=i.space_id
          WHERE i.connection_id=$1 AND i.space_id=$2 AND i.provider_id='discord' AND c.provider_id='discord'
            AND i.app_client_id=$3 AND i.event_scope_id=$4 AND i.discord_authorized_at<=$5
            AND ($6::text IS NULL OR (i.installation_id=$6 AND c.status='configured')) FOR UPDATE OF i,k`,
        values: [target.connection_id, target.space_id, input.appClientId, input.userId, eventAt.toISOString(), input.guildId ?? null], maxRows: 1 });
        if (!current.length) continue;
        matched++;
        if (input.type !== "APPLICATION_DEAUTHORIZED") continue;
        await tx.query({ name: "discord_lifecycle_credentials_retire_v1", text: `DELETE FROM data.app_connector_credentials WHERE connection_id=$1`, values: [target.connection_id], maxRows: 0 });
        await tx.query({ name: "discord_lifecycle_binding_retire_v1", text: `DELETE FROM data.app_connector_oauth_installations WHERE connection_id=$1`, values: [target.connection_id], maxRows: 0 });
        await tx.query({ name: "discord_lifecycle_connection_retire_v1", text: `UPDATE data.app_connector_connections
          SET status='disconnected',error=NULL,last_checked_at=NULL,version=version+1,updated_at=statement_timestamp() WHERE connection_id=$1`,
        values: [target.connection_id], maxRows: 0 });
      }
      return { matched };
    });
  }
}
