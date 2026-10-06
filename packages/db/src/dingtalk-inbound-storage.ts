import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { dingtalkDenied } from "./dingtalk-company-values.js";
import { dingtalkCurrentInstallation, dingtalkPreparedInstallation } from "./dingtalk-company-control.js";
import { dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import { dingtalkTransactionPreparation } from "./dingtalk-prepared-port.js";
import { dingtalkCompanyLock } from "./dingtalk-company-values.js";

export async function dingtalkInboundLock(tx: DatabaseTransaction, identity: string) {
  await tx.query({ name: "dingtalk_inbound_capacity_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    values: [`dingtalk-inbound:${identity}`], maxRows: 1 });
}
/** Never carry cleanup's FK child locks into a subsequent company-lock wait. */
export async function dingtalkInboundMaintain(database: AuthorityDatabase, identity: string, requestId: string) {
  await database.transaction({ requestId, operation: "app.dingtalk.inbound-maintain" }, async tx => {
    await dingtalkInboundLock(tx, identity);
    await dingtalkInboundCleanup(tx, identity);
  });
}
/** Each query limits rows; jobs retain obsolete evidence independently of deleted company grants. */
export async function dingtalkInboundCleanup(tx: DatabaseTransaction, identity: string) {
  await tx.query({ name: "dingtalk_inbound_attempt_cleanup_v1", text: `DELETE FROM data.app_dingtalk_inbound_attempts
    WHERE state_digest IN (SELECT state_digest FROM data.app_dingtalk_inbound_attempts WHERE app_identity=$1
      AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 8 FOR UPDATE SKIP LOCKED)`, values: [identity], maxRows: 0 });
  // At most fifty jobs per receipt: eight expired receipts delete at most 400 jobs.
  await tx.query({ name: "dingtalk_inbound_receipt_cleanup_v1", text: `DELETE FROM data.app_dingtalk_inbound_receipts
    WHERE (app_identity,event_digest) IN (SELECT app_identity,event_digest FROM data.app_dingtalk_inbound_receipts
      WHERE app_identity=$1 AND retain_until<=clock_timestamp() ORDER BY retain_until LIMIT 8 FOR UPDATE SKIP LOCKED)`,
    values: [identity], maxRows: 0 });
  await tx.query({ name: "dingtalk_inbound_job_cleanup_v1", text: `WITH expired AS (
    SELECT j.app_identity,j.event_digest,j.connection_id,j.inbound_generation,
      (j.payload_expires_epoch<=extract(epoch from clock_timestamp())*1000 OR NOT source.authorized) AS obsolete
    FROM data.app_dingtalk_inbound_jobs j CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM data.app_dingtalk_inbound_scopes s JOIN data.app_dingtalk_company_grants g USING(connection_id)
        JOIN data.app_connector_connections c USING(connection_id)
        JOIN data.space_members m ON m.space_id=s.space_id AND m.user_id=s.actor_user_id
        WHERE s.connection_id=j.connection_id AND s.scope_digest=j.scope_digest AND s.active
          AND s.app_identity=j.app_identity AND s.inbound_generation=j.inbound_generation
          AND s.parent_generation=g.grant_generation AND g.grant_generation=j.parent_generation
          AND s.connection_generation=c.search_rank_sequence AND c.status='configured' AND c.provider_id='dingtalk'
          AND m.role IN ('owner','admin') AND m.version::text || ':' || (extract(epoch from m.created_at)*1000000)::bigint::text=s.actor_membership_generation
          AND EXISTS (SELECT 1 FROM data.app_dingtalk_company_visibility v WHERE v.app_identity=g.app_identity
            AND v.company_digest=g.company_digest AND v.version=g.visibility_version AND NOT v.ambiguous)
          AND NOT EXISTS(SELECT 1 FROM data.app_connector_credentials WHERE connection_id=c.connection_id)
          AND NOT EXISTS(SELECT 1 FROM data.space_deletions WHERE space_id=s.space_id)
          AND NOT EXISTS(SELECT 1 FROM data.app_dingtalk_company_fences f WHERE f.app_identity=g.app_identity
            AND f.company_digest=g.company_digest AND f.changed_at>=g.started_at)) AS authorized) source
    WHERE j.app_identity=$1 AND j.state IN ('pending','leased') AND (NOT source.authorized OR
      j.payload_expires_epoch<=extract(epoch from clock_timestamp())*1000 OR
      (j.state='leased' AND j.attempts>=5 AND j.lease_until<=clock_timestamp()))
    ORDER BY j.available_at,j.event_digest LIMIT 8 FOR UPDATE OF j SKIP LOCKED)
    UPDATE data.app_dingtalk_inbound_jobs j SET state=CASE WHEN e.obsolete THEN 'obsolete' ELSE 'failed' END,
      lease_id=NULL,lease_until=NULL,encrypted_value_json='{}'::jsonb FROM expired e
    WHERE (j.app_identity,j.event_digest,j.connection_id,j.inbound_generation)=
      (e.app_identity,e.event_digest,e.connection_id,e.inbound_generation)`, values: [identity], maxRows: 0 });
  await tx.query({ name: "dingtalk_inbound_scope_cleanup_v1", text: `DELETE FROM data.app_dingtalk_inbound_scopes
    WHERE (connection_id,scope_digest) IN (SELECT connection_id,scope_digest FROM data.app_dingtalk_inbound_scopes
      WHERE app_identity=$1 AND NOT active ORDER BY confirmed_at LIMIT 8 FOR UPDATE SKIP LOCKED)`, values: [identity], maxRows: 0 });
}
export function dingtalkInboundParentFields(row: QueryResultRow) {
  return { connection_id: row.connection_id, space_id: row.space_id, app_identity: row.app_identity,
    company_digest: row.company_digest, parent_generation: row.grant_generation, actor_user_id: row.actor_user_id,
    actor_membership_generation: row.actor_membership_generation, connection_generation: row.connection_generation,
    visibility_version: row.visibility_version };
}
export async function dingtalkInboundParent(tx: DatabaseTransaction, key: string, app: DingTalkAppIdentity, row: QueryResultRow) {
  const parent = await (dingtalkTransactionPreparation(tx)?.gid.endsWith(":s") ? dingtalkPreparedInstallation : dingtalkCurrentInstallation)(tx, key, app, String(row.space_id));
  if (!parent || Object.entries(dingtalkInboundParentFields(parent.row)).some(([k,v]) => String(v) !== String(row[k]))) return null;
  return parent.installation;
}
/** Discover only the opaque lock key; authenticate after taking the same lock as retirement. */
export async function dingtalkInboundParentForSpace(tx: DatabaseTransaction, key: string, app: DingTalkAppIdentity, spaceId: string) {
  const rows = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_parent_lock_target_v1",
    text: "SELECT company_digest FROM data.app_dingtalk_company_grants WHERE connection_id=$1 AND app_identity=$2",
    values: [`${spaceId}:dingtalk`,dingtalkAppIdentity(app)],maxRows: 1 });
  if (!rows[0]) dingtalkDenied();
  await dingtalkCompanyLock(tx,dingtalkAppIdentity(app),String(rows[0].company_digest));
  const parent = await dingtalkCurrentInstallation(tx,key,app,spaceId);
  if (!parent || parent.row.company_digest!==rows[0].company_digest) dingtalkDenied();
  return parent;
}
export function dingtalkInboundOriginal(row: QueryResultRow, actor: string) {
  if (String(row.actor_user_id) !== actor) dingtalkDenied();
}
