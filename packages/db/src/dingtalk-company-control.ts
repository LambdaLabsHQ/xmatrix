import { appRequestText as text } from "./app-request-text.js";
import { appTicketEventTime } from "./app-ticket-control.js";
import { dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import { dingtalkVisible } from "./dingtalk-visibility-control.js";
import {
  dingtalkAdmin,
  dingtalkPrimary,
  dingtalkCompanyDigest,
  dingtalkCompanyLock,
  dingtalkDecrypt,
  dingtalkDenied,
  dingtalkGrant,
  dingtalkMaintain,
  DINGTALK_MEMBER,
  type DingTalkCompanyGrant,
  type DingTalkInstallation,
} from "./dingtalk-company-values.js";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { dingtalkTransactionPreparation } from "./dingtalk-prepared-port.js";

type Request = { requestId: string; app: DingTalkAppIdentity };
export function dingtalkActiveGrantSql(appIdentitySql: "$1", allowErrorSql: "$2", preparedNativeOnly=false) {
  return `FROM data.app_dingtalk_company_grants g JOIN data.app_connector_connections c USING(connection_id)
  WHERE g.app_identity=${appIdentitySql} AND c.provider_id='dingtalk' AND g.connection_generation=c.search_rank_sequence
    AND (c.status='configured' OR (${allowErrorSql} AND c.status='error'))
    ${preparedNativeOnly ? '' : `AND EXISTS (SELECT 1 FROM data.space_members m WHERE m.space_id=g.space_id AND m.user_id=g.actor_user_id
      AND m.role IN ('owner','admin') AND m.version::text || ':' || (extract(epoch from m.created_at)*1000000)::bigint::text=g.actor_membership_generation)
    AND NOT EXISTS (SELECT 1 FROM data.space_deletions WHERE space_id=g.space_id)`}
    AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials WHERE connection_id=g.connection_id)
    AND EXISTS (SELECT 1 FROM data.app_dingtalk_company_visibility s WHERE s.app_identity=g.app_identity
      AND s.company_digest=g.company_digest AND s.version=g.visibility_version AND NOT s.ambiguous)
    AND NOT EXISTS (SELECT 1 FROM data.app_dingtalk_company_fences f WHERE f.app_identity=g.app_identity
      AND f.company_digest=g.company_digest AND f.changed_at>=g.started_at)`;
}

/** Current grants have no token cache or caller-provided provider proof. Resolve from the primary authority on each effect. */
export async function dingtalkDecodeInstallation(tx: DatabaseTransaction, key: string, row: QueryResultRow, preparedNativeOnly=false): Promise<DingTalkInstallation> {
    if (preparedNativeOnly && !dingtalkTransactionPreparation(tx)?.gid.endsWith(":s")) dingtalkDenied();
    if (!preparedNativeOnly &&
      (await dingtalkAdmin(tx, String(row.space_id), String(row.actor_user_id))) !==
      String(row.actor_membership_generation)
    )
      dingtalkDenied();
    const grant = dingtalkGrant((await dingtalkDecrypt(key, row, false)) as DingTalkCompanyGrant);
    const [prefix, suiteKey, eventKeyDigest] = String(row.app_identity).split("|");
    if (
      prefix !== "dingtalk" ||
      !suiteKey ||
      !eventKeyDigest ||
      (await dingtalkCompanyDigest({ suiteKey, eventKeyDigest }, grant.corpId)) !== row.company_digest
    )
      dingtalkDenied();
    const visible = await dingtalkVisible(tx, key, { suiteKey, eventKeyDigest }, grant);
    if (visible !== Number(row.visibility_version)) dingtalkDenied();
    return {
      ...grant,
      spaceId: String(row.space_id),
      connectionId: String(row.connection_id),
      appIdentity: String(row.app_identity),
      companyDigest: String(row.company_digest),
      connectionGeneration: String(row.connection_generation),
      grantGeneration: String(row.grant_generation),
      actorUserId: String(row.actor_user_id),
    };
}

/** Transaction-scoped primary check for consent and inbox owners; locks current membership and visible scope too. */
export async function dingtalkCurrentInstallation(tx: DatabaseTransaction, key: string, app: DingTalkAppIdentity, spaceId: string) {
  const rows = await tx.query<QueryResultRow>({ name: "dingtalk_current_installation_v1",
    text: `SELECT g.* ${dingtalkActiveGrantSql("$1", "$2")} AND g.connection_id=$3 LIMIT 1 FOR SHARE OF c,g`,
    values: [dingtalkAppIdentity(app), false, `${spaceId}:dingtalk`], maxRows: 1 });
  return rows[0] ? { row: rows[0], installation: await dingtalkDecodeInstallation(tx, key, rows[0]) } : null;
}

/** Private prepared-source participant. Space authority stays at the target
 * owner; the ordinary current API retains its original primary checks. */
export async function dingtalkPreparedInstallation(tx: DatabaseTransaction,key: string,app: DingTalkAppIdentity,spaceId: string) {
  if (!dingtalkTransactionPreparation(tx)?.gid.endsWith(":s")) dingtalkDenied();
  const rows=await tx.query<QueryResultRow>({ name: "dingtalk_prepared_installation_v1",
    text: `SELECT g.* ${dingtalkActiveGrantSql("$1","$2",true)} AND g.connection_id=$3 LIMIT 1 FOR SHARE OF c,g`,
    values: [dingtalkAppIdentity(app),false,`${spaceId}:dingtalk`],maxRows: 1 });
  return rows[0] ? { row: rows[0],installation: await dingtalkDecodeInstallation(tx,key,rows[0],true) } : null;
}

export class PostgresDingTalkCompanyRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly key: string) {
    dingtalkPrimary(database, key);
  }
  async resolve(input: Request & { spaceId: string; forCheck?: boolean }): Promise<DingTalkInstallation | null> {
    const identity = dingtalkAppIdentity(input.app),
      spaceId = text(input.spaceId, "spaceId");
    return this.database.transaction(
      {
        requestId: text(input.requestId, "requestId", 200),
        operation: "app.dingtalk.grant-resolve",
      },
      async (tx) => {
        await dingtalkMaintain(tx);
        const rows = await tx.query<QueryResultRow>({
          name: "dingtalk_grant_resolve_v1",
          text: `SELECT g.* ${dingtalkActiveGrantSql("$1", "$2")} AND g.connection_id=$3 LIMIT 1 FOR SHARE OF c,g`,
          values: [identity, !!input.forCheck, `${spaceId}:dingtalk`],
          maxRows: 1,
        });
        return rows[0] ? dingtalkDecodeInstallation(tx, this.key, rows[0]) : null;
      },
    );
  }
  async current(input: Request & { installation: DingTalkInstallation; forCheck?: boolean }) {
    const now = await this.resolve({
      ...input,
      spaceId: input.installation.spaceId,
    });
    return now !== null && JSON.stringify(now) === JSON.stringify(input.installation);
  }
  async incoming(input: Request & { corpId: string; memberId: string; eventTime: string }) {
    const identity = dingtalkAppIdentity(input.app),
      company = await dingtalkCompanyDigest(input.app, input.corpId),
      at = appTicketEventTime(input.eventTime);
    if (!DINGTALK_MEMBER.test(input.memberId) || input.memberId.toLowerCase() === "@all") dingtalkDenied();
    return this.database.transaction(
      {
        requestId: text(input.requestId, "requestId", 200),
        operation: "app.dingtalk.grant-incoming",
      },
      async (tx) => {
        const rows = await tx.query<QueryResultRow>({
          name: "dingtalk_grant_incoming_v1",
          text: `SELECT g.* ${dingtalkActiveGrantSql("$1", "$2")}
        AND g.company_digest=$3 AND g.confirmed_at<=$4::timestamptz
        AND $4::timestamptz BETWEEN clock_timestamp()-interval '10 minutes' AND clock_timestamp()+interval '30 seconds'
        ORDER BY g.connection_id LIMIT 51 FOR SHARE OF c,g`,
          values: [identity, false, company, at],
          maxRows: 51,
        });
        if (rows.length > 50) dingtalkDenied();
        const grants = await Promise.all(rows.map((row) => dingtalkDecodeInstallation(tx, this.key, row)));
        return grants.filter((grant) => grant.corpId === input.corpId && grant.members.includes(input.memberId));
      },
    );
  }
  /** Authenticated lifecycle/visibility events fence consent and private grants together, including pending starts. */
  async retire(input: Request & { corpId: string; eventTime: string }) {
    const identity = dingtalkAppIdentity(input.app),
      company = await dingtalkCompanyDigest(input.app, input.corpId),
      at = appTicketEventTime(input.eventTime);
    return this.database.transaction(
      {
        requestId: text(input.requestId, "requestId", 200),
        operation: "app.dingtalk.grant-retire",
      },
      async (tx) => {
        await tx.query({
          name: "dingtalk_fence_capacity_lock_v1",
          text: "SELECT pg_advisory_xact_lock(hashtextextended('dingtalk-fences',0))",
          values: [],
          maxRows: 1,
        });
        await dingtalkCompanyLock(tx, identity, company);
        await dingtalkMaintain(tx);
        const bounds = await tx.query<QueryResultRow>({
          name: "dingtalk_fence_bounds_v1",
          text: `SELECT
        $3::timestamptz BETWEEN clock_timestamp()-interval '10 minutes' AND clock_timestamp()+interval '30 seconds' AS fresh,
        EXISTS(SELECT 1 FROM data.app_dingtalk_company_fences WHERE app_identity=$1 AND company_digest=$2) AS present,
        (SELECT count(*) FROM (SELECT 1 FROM data.app_dingtalk_company_fences LIMIT 10000) bounded) AS n`,
          values: [identity, company, at],
          maxRows: 1,
        });
        if (!bounds[0]?.fresh || (!bounds[0]?.present && Number(bounds[0]?.n) >= 10000)) dingtalkDenied();
        // Millisecond and second provider timestamps are both supported; second-granularity ties always lose authority.
        await tx.query({
          name: "dingtalk_fence_save_v1",
          text: `INSERT INTO data.app_dingtalk_company_fences VALUES ($1,$2,$3::timestamptz+interval '1 second')
        ON CONFLICT(app_identity,company_digest) DO UPDATE SET changed_at=greatest(data.app_dingtalk_company_fences.changed_at,EXCLUDED.changed_at)`,
          values: [identity, company, at],
          maxRows: 0,
        });
        const grants = await tx.query<QueryResultRow>({
          name: "dingtalk_retire_grants_v1",
          text: `SELECT g.connection_id FROM data.app_dingtalk_company_grants g
        JOIN data.app_connector_connections c USING(connection_id) WHERE g.app_identity=$1 AND g.company_digest=$2
          AND g.started_at<$3::timestamptz+interval '1 second' ORDER BY g.connection_id LIMIT 51 FOR UPDATE OF c,g`,
          values: [identity, company, at],
          maxRows: 51,
        });
        const attempts = await tx.query<QueryResultRow>({
          name: "dingtalk_retire_attempts_v1",
          text: `SELECT state_digest FROM data.app_dingtalk_company_attempts
        WHERE app_identity=$1 AND company_digest=$2 AND started_at<$3::timestamptz+interval '1 second' LIMIT 51 FOR UPDATE`,
          values: [identity, company, at],
          maxRows: 51,
        });
        if (grants.length > 50 || attempts.length > 50) dingtalkDenied();
        const scopes = await tx.query<QueryResultRow>({
          name: "dingtalk_retire_visibility_v1",
          text: `SELECT app_id
          FROM data.app_dingtalk_company_visibility WHERE app_identity=$1 AND company_digest=$2
            AND event_time<$3::timestamptz+interval '1 second' LIMIT 51 FOR UPDATE`,
          values: [identity, company, at],
          maxRows: 51,
        });
        if (scopes.length > 50) dingtalkDenied();
        await tx.query({
          name: "dingtalk_retire_scope_purge_v1",
          text: `UPDATE data.app_dingtalk_company_visibility
          SET encrypted_value_json='{}'::jsonb,ambiguous=true,version=version+1
          WHERE app_identity=$1 AND company_digest=$2 AND app_id=ANY($3::bigint[])`,
          values: [identity, company, scopes.map((row) => String(row.app_id))],
          maxRows: 0,
        });
        const ids = grants.map((row) => String(row.connection_id));
        await tx.query({
          name: "dingtalk_retire_private_v1",
          text: "DELETE FROM data.app_dingtalk_company_grants WHERE connection_id=ANY($1::text[])",
          values: [ids],
          maxRows: 0,
        });
        await tx.query({
          name: "dingtalk_retire_pending_v1",
          text: "DELETE FROM data.app_dingtalk_company_attempts WHERE state_digest=ANY($1::text[])",
          values: [attempts.map((row) => String(row.state_digest))],
          maxRows: 0,
        });
        await tx.query({
          name: "dingtalk_retire_status_v1",
          text: `UPDATE data.app_connector_connections SET status='disconnected',error=NULL,
        version=version+1,updated_at=statement_timestamp() WHERE connection_id=ANY($1::text[])`,
          values: [ids],
          maxRows: 0,
        });
        return { retired: ids.length };
      },
    );
  }
}
