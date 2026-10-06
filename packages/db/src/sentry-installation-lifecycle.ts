import type { QueryResultRow } from "pg";
import type { DatabaseTransaction } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import type { AppOAuthInstallation } from "./app-credential-control.js";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

export function sentryInstallationKey(installation: AppOAuthInstallation): [string, string, string] {
  if (!/^[A-Za-z0-9._-]{1,256}$/u.test(installation.appClientId) ||
      !UUID.test(installation.installationId) || !UUID.test(installation.eventScopeId ?? "")) {
    throw new AppControlError("invalid_app_request", 400, "Invalid Sentry installation identity");
  }
  return [installation.appClientId, installation.eventScopeId!, installation.installationId];
}

/** At most 50 expired records, scoped to this configured application, per lifecycle write. */
async function expireRecords(tx: DatabaseTransaction, key: [string, string, string]) {
  await tx.query({ name: "sentry_install_lifecycle_expire_v1", text: `DELETE FROM data.app_sentry_installation_lifecycle
    WHERE (app_client_id,app_uuid,installation_uuid) IN (SELECT app_client_id,app_uuid,installation_uuid
      FROM data.app_sentry_installation_lifecycle WHERE app_client_id=$1 AND app_uuid=$2::uuid
      AND expires_at < statement_timestamp() ORDER BY expires_at,installation_uuid LIMIT 50 FOR UPDATE SKIP LOCKED)`,
  values: key.slice(0, 2), maxRows: 0 });
}

/** Serialize attempt creation and retirement, including retirement before any Space binding. */
export async function lockSentryInstallation(tx: DatabaseTransaction, installation: AppOAuthInstallation) {
  const key = sentryInstallationKey(installation);
  await expireRecords(tx, key);
  await tx.query({ name: "sentry_install_lifecycle_prepare_v1", text: `INSERT INTO data.app_sentry_installation_lifecycle
    (app_client_id,app_uuid,installation_uuid,expires_at) VALUES ($1,$2::uuid,$3::uuid,
      statement_timestamp()+interval '1 day') ON CONFLICT DO NOTHING`, values: key, maxRows: 0 });
  const rows = await tx.query<QueryResultRow>({ name: "sentry_install_lifecycle_lock_v1", text: `SELECT retired_at
    FROM data.app_sentry_installation_lifecycle WHERE app_client_id=$1 AND app_uuid=$2::uuid
      AND installation_uuid=$3::uuid FOR UPDATE`, values: key, maxRows: 1 });
  if (!rows[0]) throw new AppControlError("installation_changed", 409, "Sentry installation changed");
  return { key, retired: rows[0].retired_at !== null };
}

export async function limitSentryBindings(tx: DatabaseTransaction, installation: AppOAuthInstallation, connectionId: string) {
  const rows = await tx.query<QueryResultRow>({ name: "sentry_install_binding_capacity_v1", text: `SELECT connection_id
    FROM data.app_connector_oauth_installations WHERE provider_id='sentry' AND app_client_id=$1
      AND event_scope_id=$2 AND installation_id=$3 ORDER BY connection_id LIMIT 51`,
  values: sentryInstallationKey(installation), maxRows: 51 });
  if (rows.length > 50 || (rows.length === 50 && !rows.some(row => row.connection_id === connectionId))) {
    throw new AppControlError("too_many_installations", 503, "Sentry installation binding capacity reached", true);
  }
}

/** A live request is valid for one minute. It is never returned to a client or command replay. */
export async function beginSentryAttempt(tx: DatabaseTransaction, installation: AppOAuthInstallation, spaceId: string) {
  const { key, retired } = await lockSentryInstallation(tx, installation);
  if (retired) throw new AppControlError("installation_retired", 409, "Sentry installation was uninstalled; start again");
  await limitSentryBindings(tx, installation, `${spaceId}:sentry`);
  const attemptId = crypto.randomUUID();
  await tx.query({ name: "sentry_install_attempt_begin_v1", text: `UPDATE data.app_sentry_installation_lifecycle
    SET attempt_id=$4::uuid,attempt_space_id=$5,attempt_expires_at=statement_timestamp()+interval '1 minute',
      expires_at=statement_timestamp()+interval '1 day'
    WHERE app_client_id=$1 AND app_uuid=$2::uuid AND installation_uuid=$3::uuid`,
  values: [...key, attemptId, spaceId], maxRows: 0 });
  return attemptId;
}

export async function lockSentryAttempt(tx: DatabaseTransaction, installation: AppOAuthInstallation, spaceId: string,
  attemptId: string, tokenExpiresAt: string) {
  if (!UUID.test(attemptId)) throw new AppControlError("invalid_app_request", 400, "Invalid Sentry installation attempt");
  const rows = await tx.query<QueryResultRow>({ name: "sentry_install_attempt_check_v1", text: `SELECT installation_uuid
    FROM data.app_sentry_installation_lifecycle WHERE app_client_id=$1 AND app_uuid=$2::uuid
      AND installation_uuid=$3::uuid AND attempt_id=$4::uuid AND attempt_space_id=$5
      AND retired_at IS NULL AND attempt_expires_at > statement_timestamp()
      AND $6::bigint > extract(epoch FROM statement_timestamp())*1000
      AND $6::bigint <= extract(epoch FROM statement_timestamp())*1000+86400000 FOR UPDATE`,
  values: [...sentryInstallationKey(installation), attemptId, spaceId, tokenExpiresAt], maxRows: 1 });
  if (!rows[0]) throw new AppControlError("installation_changed", 409, "Sentry installation expired, changed or was uninstalled");
  await limitSentryBindings(tx, installation, `${spaceId}:sentry`);
}

export async function consumeSentryAttempt(tx: DatabaseTransaction, installation: AppOAuthInstallation) {
  await tx.query({ name: "sentry_install_attempt_consume_v1", text: `UPDATE data.app_sentry_installation_lifecycle
    SET attempt_id=NULL,attempt_space_id=NULL,attempt_expires_at=NULL
    WHERE app_client_id=$1 AND app_uuid=$2::uuid AND installation_uuid=$3::uuid`,
  values: sentryInstallationKey(installation), maxRows: 0 });
}

/** A short-lived attempt cannot survive this seven-day signed retirement record. */
export async function retireSentryAttempt(tx: DatabaseTransaction, installation: AppOAuthInstallation) {
  const { key } = await lockSentryInstallation(tx, installation);
  await tx.query({ name: "sentry_install_attempt_retire_v1", text: `UPDATE data.app_sentry_installation_lifecycle
    SET retired_at=statement_timestamp(),expires_at=statement_timestamp()+interval '7 days',
      attempt_id=NULL,attempt_space_id=NULL,attempt_expires_at=NULL
    WHERE app_client_id=$1 AND app_uuid=$2::uuid AND installation_uuid=$3::uuid`, values: key, maxRows: 0 });
}
