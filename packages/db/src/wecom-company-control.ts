import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";
import { appTicketEventTime } from "./app-ticket-control.js";
import { wecomAppIdentity, type WeComAppIdentity } from "./wecom-suite-control.js";
import { lockWeComCompany, validateWeComGrant, wecomCompanyDigest, wecomDecrypt,
  maintainWeCom, wecomDenied, wecomEncrypt, wecomMembers, type WeComInstallation } from "./wecom-company-values.js";

type Request = { requestId: string; app: WeComAppIdentity };
const ACTIVE = `FROM data.app_wecom_installations g JOIN data.app_connector_connections c USING(connection_id)
  WHERE g.app_identity=$1 AND g.connection_generation=c.search_rank_sequence AND c.provider_id='wecom'
    AND (c.status='configured' OR ($2 AND c.status='error'))
    AND NOT EXISTS (SELECT 1 FROM data.app_connector_credentials k WHERE k.connection_id=g.connection_id)
    AND NOT EXISTS (SELECT 1 FROM data.space_deletions d WHERE d.space_id=g.space_id)
    AND NOT EXISTS (SELECT 1 FROM data.app_wecom_company_lifecycle l WHERE l.app_identity=g.app_identity
      AND l.company_digest=g.company_digest AND l.changed_at>=g.started_at)`;

/** Provider-authenticated company/member grants remain inside the primary encrypted App authority. */
export class PostgresWeComCompanyRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {
    if (database.cacheMode !== "disabled" || !material) throw new AppControlError("wecom_authority_unavailable", 503, "WeCom private authority is unavailable");
  }
  private async installation(row: QueryResultRow): Promise<WeComInstallation> {
    const owner = JSON.stringify([row.connection_id, row.app_identity, row.company_digest, row.connection_generation]);
    const values = await wecomDecrypt(this.material, owner, Number(row.version), row.encrypted_value_json);
    const grant = validateWeComGrant(values.grant as never), members = wecomMembers(values.members as string[]);
    if (Object.keys(values).some(key => !["grant", "members"].includes(key))) wecomDenied();
    if (await wecomCompanyDigest({ suiteId: String(row.app_identity).split("|")[1]!, eventKeyDigest: String(row.app_identity).split("|")[2]! }, grant.corpId) !== row.company_digest) wecomDenied();
    return { ...grant, members, connectionId: String(row.connection_id), spaceId: String(row.space_id),
      appIdentity: String(row.app_identity), companyDigest: String(row.company_digest),
      grantGeneration: String(row.grant_generation), connectionGeneration: String(row.connection_generation) };
  }
  async resolve(input: Request & { spaceId: string; forCheck?: boolean }): Promise<WeComInstallation | null> {
    const identity = wecomAppIdentity(input.app), spaceId = text(input.spaceId, "spaceId");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.company-resolve" }, async tx => {
      await maintainWeCom(tx);
      const rows = await tx.query<QueryResultRow>({ name: "wecom_company_resolve_v1", text: `SELECT g.* ${ACTIVE}
        AND g.connection_id=$3 LIMIT 1`, values: [identity, !!input.forCheck, `${spaceId}:wecom`], maxRows: 1 });
      return rows[0] ? this.installation(rows[0]) : null;
    });
  }
  async current(input: Request & { installation: WeComInstallation; forCheck?: boolean }): Promise<boolean> {
    const live = await this.resolve({ ...input, spaceId: input.installation.spaceId });
    return !!live && live.grantGeneration === input.installation.grantGeneration && live.connectionGeneration === input.installation.connectionGeneration;
  }
  async routes(input: Request & { corpId: string; agentId: number; memberId: string; eventTime: string }): Promise<WeComInstallation[]> {
    const identity = wecomAppIdentity(input.app), company = await wecomCompanyDigest(input.app, input.corpId);
    const member = wecomMembers([input.memberId])[0]!;
    const eventTime = appTicketEventTime(input.eventTime);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.company-route" }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "wecom_company_route_v1", text: `SELECT g.* ${ACTIVE}
        AND g.company_digest=$3 AND g.confirmed_at<=$4::timestamptz
        AND $4::timestamptz>=clock_timestamp()-interval '10 minutes' AND $4::timestamptz<=clock_timestamp()+interval '30 seconds'
        ORDER BY g.connection_id LIMIT 51`, values: [identity, false, company, eventTime], maxRows: 51 });
      if (rows.length > 50) wecomDenied();
      const installations = await Promise.all(rows.map(row => this.installation(row)));
      return installations.filter(value => value.corpId === input.corpId && value.agentId === input.agentId && value.members.includes(member));
    });
  }
  /** Both cancellation and a visibility change immediately close grants; fresh Human authorization is required. */
  async retire(input: Request & { corpId: string; eventTime: string }) {
    const identity = wecomAppIdentity(input.app), company = await wecomCompanyDigest(input.app, input.corpId);
    const at = appTicketEventTime(input.eventTime);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.company-retire" }, async tx => {
      await tx.query({ name: "wecom_lifecycle_capacity_lock_v1", text: "SELECT pg_advisory_xact_lock(hashtextextended('wecom-lifecycle-capacity',0))", values: [], maxRows: 1 });
      await maintainWeCom(tx);
      await lockWeComCompany(tx, identity, company);
      const fresh = await tx.query<QueryResultRow>({ name: "wecom_retirement_fresh_v1", text: `SELECT 1 WHERE
        $1::timestamptz>=clock_timestamp()-interval '10 minutes' AND $1::timestamptz<=clock_timestamp()+interval '30 seconds'`, values: [at], maxRows: 1 });
      if (!fresh.length) wecomDenied();
      const capacity = await tx.query<QueryResultRow>({ name: "wecom_lifecycle_capacity_v1", text: `SELECT
        EXISTS(SELECT 1 FROM data.app_wecom_company_lifecycle WHERE app_identity=$1 AND company_digest=$2) AS present,
        (SELECT count(*) FROM (SELECT 1 FROM data.app_wecom_company_lifecycle LIMIT 10000) bounded) AS n`, values: [identity, company], maxRows: 1 });
      if (!capacity[0]?.present && Number(capacity[0]?.n) >= 10000) throw new AppControlError("wecom_retirement_capacity", 503, "WeCom retirement capacity is unavailable");
      // Provider timestamps have second precision. An indistinguishable installation in that second loses authority.
      await tx.query({ name: "wecom_retirement_barrier_v1", text: `INSERT INTO data.app_wecom_company_lifecycle
        (app_identity,company_digest,changed_at) VALUES ($1,$2,$3::timestamptz+interval '1 second') ON CONFLICT(app_identity,company_digest)
        DO UPDATE SET changed_at=greatest(data.app_wecom_company_lifecycle.changed_at,EXCLUDED.changed_at)`, values: [identity, company, at], maxRows: 0 });
      const targets = await tx.query<QueryResultRow>({ name: "wecom_retirement_targets_v1", text: `SELECT g.connection_id
        FROM data.app_wecom_installations g JOIN data.app_connector_connections c USING(connection_id)
        WHERE g.app_identity=$1 AND g.company_digest=$2 AND g.started_at<$3::timestamptz+interval '1 second'
        ORDER BY g.connection_id LIMIT 51 FOR UPDATE OF c,g`, values: [identity, company, at], maxRows: 51 });
      const attempts = await tx.query<QueryResultRow>({ name: "wecom_retirement_attempts_v1", text: `SELECT state_digest FROM data.app_wecom_install_attempts
        WHERE app_identity=$1 AND company_digest=$2 AND started_at<$3::timestamptz+interval '1 second' LIMIT 51 FOR UPDATE`,
      values: [identity, company, at], maxRows: 51 });
      if (targets.length > 50 || attempts.length > 50) wecomDenied();
      const ids = targets.map(value => String(value.connection_id)), states = attempts.map(value => String(value.state_digest));
      await tx.query({ name: "wecom_retirement_private_purge_v1", text: `DELETE FROM data.app_wecom_installations WHERE connection_id=ANY($1::text[])`, values: [ids], maxRows: 0 });
      await tx.query({ name: "wecom_retirement_attempt_purge_v1", text: `DELETE FROM data.app_wecom_install_attempts WHERE state_digest=ANY($1::text[])`, values: [states], maxRows: 0 });
      await tx.query({ name: "wecom_retirement_connection_v1", text: `UPDATE data.app_connector_connections SET
        status='disconnected',error=NULL,version=version+1,updated_at=statement_timestamp() WHERE connection_id=ANY($1::text[])`, values: [ids], maxRows: 0 });
      return { retired: ids.length };
    });
  }
  /** A short primary lease serializes native suite token renewal without holding a transaction over HTTP. */
  async suiteToken(input: Request): Promise<{ value: string } | { leaseId: string; version: number }> {
    const identity = wecomAppIdentity(input.app);
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.token-claim" }, async tx => {
      await tx.query({ name: "wecom_suite_token_initialize_v1", text: `INSERT INTO data.app_wecom_suite_tokens(app_identity)
        VALUES ($1) ON CONFLICT DO NOTHING`, values: [identity], maxRows: 0 });
      const rows = await tx.query<QueryResultRow>({ name: "wecom_suite_token_lock_v1", text: `SELECT *,expires_at>clock_timestamp()+interval '60 seconds' AS fresh,
        lease_until>clock_timestamp() AS leased FROM data.app_wecom_suite_tokens WHERE app_identity=$1 FOR UPDATE`, values: [identity], maxRows: 1 });
      const row = rows[0]!;
      if (row.fresh) {
        const result = await wecomDecrypt(this.material, `suite-token:${identity}`, Number(row.version), row.encrypted_value_json);
        if (typeof result.value !== "string" || !/^[A-Za-z0-9_.-]{8,512}$/u.test(result.value)) wecomDenied();
        return { value: result.value };
      }
      if (row.leased) throw new AppControlError("wecom_token_pending", 503, "WeCom company token renewal is pending");
      const lease = await tx.query<QueryResultRow>({ name: "wecom_suite_token_claim_v1", text: `UPDATE data.app_wecom_suite_tokens
        SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '15 seconds',version=version+1,
          encrypted_value_json='{}'::jsonb WHERE app_identity=$1 RETURNING lease_id,version`, values: [identity], maxRows: 1 });
      return { leaseId: String(lease[0]!.lease_id), version: Number(lease[0]!.version) };
    });
  }
  async saveSuiteToken(input: Request & { leaseId: string; version: number; value: string; expiresIn: number }) {
    const identity = wecomAppIdentity(input.app);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(input.leaseId) || !Number.isSafeInteger(input.version) ||
        input.version < 1 || !/^[A-Za-z0-9_.-]{8,512}$/u.test(input.value) || !Number.isSafeInteger(input.expiresIn) ||
        input.expiresIn < 1 || input.expiresIn > 7200) wecomDenied();
    const envelope = await wecomEncrypt(this.material, `suite-token:${identity}`, input.version, { value: input.value });
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.token-save" }, async tx => {
      const rows = await tx.query({ name: "wecom_suite_token_save_v1", text: `UPDATE data.app_wecom_suite_tokens SET
        encrypted_value_json=$4::jsonb,expires_at=clock_timestamp()+make_interval(secs=>$5),lease_id=NULL,lease_until=NULL
        WHERE app_identity=$1 AND lease_id=$2::uuid AND version=$3 AND lease_until>clock_timestamp() RETURNING app_identity`,
      values: [identity, input.leaseId, input.version, JSON.stringify(envelope), Math.max(1, input.expiresIn - 30)], maxRows: 1 });
      if (!rows.length) wecomDenied();
    });
  }
}
