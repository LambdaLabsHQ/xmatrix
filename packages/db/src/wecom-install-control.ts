import { lowercaseHex, sha256Hex } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";
import { wecomAppIdentity, type WeComAppIdentity } from "./wecom-suite-control.js";
import { lockWeComCompany, validateWeComGrant, wecomAdmin, wecomCompanyDigest, wecomConnection,
  maintainWeCom, wecomAttemptOwner, wecomDecrypt, wecomDenied, wecomEncrypt, wecomMembers, type WeComCompanyGrant } from "./wecom-company-values.js";

type Request = { requestId: string; app: WeComAppIdentity };
async function state(value: string) {
  if (!/^[a-f0-9]{64}$/u.test(value)) wecomDenied();
  return sha256Hex(value);
}
function unchanged(snapshot: Awaited<ReturnType<typeof wecomConnection>>, attempt: QueryResultRow) {
  if (snapshot.connectionVersion !== Number(attempt.connection_version) || snapshot.credentialVersion !== Number(attempt.credential_version) ||
      snapshot.generation !== attempt.connection_generation || snapshot.spaceId !== attempt.space_id) wecomDenied();
}
/** One-use Human and connection-bound installation. No auth code enters the database or command replay. */
export class PostgresWeComInstallRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly material: string) {
    if (database.cacheMode !== "disabled" || !material) throw new AppControlError("wecom_authority_unavailable", 503, "WeCom private authority is unavailable");
  }
  async begin(input: Request & { spaceId: string; actorUserId: string }) {
    const spaceId = text(input.spaceId, "spaceId"), actor = text(input.actorUserId, "actorUserId"), identity = wecomAppIdentity(input.app);
    const nonce = lowercaseHex(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await state(nonce);
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.install-begin" }, async tx => {
      await maintainWeCom(tx);
      const snapshot = await wecomConnection(tx, `${spaceId}:wecom`);
      await wecomAdmin(tx, spaceId, actor);
      await tx.query({ name: "wecom_install_attempt_replace_v1", text: `DELETE FROM data.app_wecom_install_attempts
        WHERE connection_id=$1`, values: [`${spaceId}:wecom`], maxRows: 0 });
      await tx.query({ name: "wecom_install_attempt_begin_v1", text: `INSERT INTO data.app_wecom_install_attempts
        (state_digest,connection_id,space_id,app_identity,actor_user_id,connection_version,credential_version,connection_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, values: [digest, `${spaceId}:wecom`, spaceId, identity, actor,
        snapshot.connectionVersion, snapshot.credentialVersion, snapshot.generation], maxRows: 0 });
    });
    return { state: nonce };
  }
  /** Commit spent state before the one-use provider exchange. A lost network result requires a fresh native authorization. */
  async take(input: Request & { state: string; actorUserId: string }): Promise<{ spaceId: string }> {
    const digest = await state(input.state), identity = wecomAppIdentity(input.app), actor = text(input.actorUserId, "actorUserId");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.install-take" }, async tx => {
      const candidates = await tx.query<QueryResultRow>({ name: "wecom_install_target_v1", text: `SELECT connection_id FROM data.app_wecom_install_attempts
        WHERE state_digest=$1 AND app_identity=$2 AND actor_user_id=$3 AND phase='started'
          AND expires_at>statement_timestamp() LIMIT 1`, values: [digest, identity, actor], maxRows: 1 });
      if (!candidates[0]) wecomDenied();
      const snapshot = await wecomConnection(tx, String(candidates[0].connection_id));
      const rows = await tx.query<QueryResultRow>({ name: "wecom_install_take_lock_v1", text: `SELECT * FROM data.app_wecom_install_attempts
        WHERE state_digest=$1 AND app_identity=$2 AND actor_user_id=$3 AND phase='started'
          AND expires_at>clock_timestamp() FOR UPDATE`, values: [digest, identity, actor], maxRows: 1 });
      const attempt = rows[0]; if (!attempt) wecomDenied();
      unchanged(snapshot, attempt); await wecomAdmin(tx, snapshot.spaceId, actor);
      await tx.query({ name: "wecom_install_take_v1", text: `UPDATE data.app_wecom_install_attempts SET phase='exchanged'
        WHERE state_digest=$1`, values: [digest], maxRows: 0 });
      return { spaceId: snapshot.spaceId };
    });
  }
  async prepare(input: Request & { state: string; actorUserId: string; grant: WeComCompanyGrant }) {
    const digest = await state(input.state), identity = wecomAppIdentity(input.app), grant = validateWeComGrant(input.grant);
    const company = await wecomCompanyDigest(input.app, grant.corpId), actor = text(input.actorUserId, "actorUserId");
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.install-prepare" }, async tx => {
      await lockWeComCompany(tx, identity, company);
      const targets = await tx.query<QueryResultRow>({ name: "wecom_install_prepare_target_v1", text: `SELECT connection_id FROM data.app_wecom_install_attempts
        WHERE state_digest=$1 AND app_identity=$2 AND actor_user_id=$3 LIMIT 1`, values: [digest, identity, actor], maxRows: 1 });
      if (!targets[0]) wecomDenied();
      const snapshot = await wecomConnection(tx, String(targets[0].connection_id));
      const rows = await tx.query<QueryResultRow>({ name: "wecom_install_prepare_lock_v1", text: `SELECT * FROM data.app_wecom_install_attempts a
        WHERE state_digest=$1 AND app_identity=$2 AND actor_user_id=$3 AND phase='exchanged' AND expires_at>clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM data.app_wecom_company_lifecycle l WHERE l.app_identity=$2
            AND l.company_digest=$4 AND l.changed_at>=a.started_at) FOR UPDATE`, values: [digest, identity, actor, company], maxRows: 1 });
      const attempt = rows[0]; if (!attempt) wecomDenied();
      unchanged(snapshot, attempt); await wecomAdmin(tx, snapshot.spaceId, actor);
      const count = await tx.query<QueryResultRow>({ name: "wecom_company_prepare_bound_v1", text: `SELECT count(*) AS n FROM
        (SELECT 1 FROM data.app_wecom_install_attempts WHERE app_identity=$1 AND company_digest=$2
          AND state_digest<>$3 LIMIT 50) bounded`, values: [identity, company, digest], maxRows: 1 });
      if (Number(count[0]?.n) >= 50) wecomDenied();
      const envelope = await wecomEncrypt(this.material, wecomAttemptOwner(attempt), 1, grant);
      await tx.query({ name: "wecom_install_prepare_v1", text: `UPDATE data.app_wecom_install_attempts
        SET phase='prepared',encrypted_value_json=$2::jsonb,company_digest=$3 WHERE state_digest=$1`, values: [digest, JSON.stringify(envelope), company], maxRows: 0 });
    });
  }
  /** Hub-only read after a Human route authenticated the original actor. Never returned as an API credential. */
  async prepared(input: Request & { state: string; actorUserId: string }) {
    const digest = await state(input.state), identity = wecomAppIdentity(input.app), actor = text(input.actorUserId, "actorUserId");
    return this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.install-prepared" }, async tx => {
      const rows = await tx.query<QueryResultRow>({ name: "wecom_install_prepared_v1", text: `SELECT a.* FROM data.app_wecom_install_attempts a
        JOIN data.app_connector_connections c USING(connection_id)
        WHERE state_digest=$1 AND app_identity=$2 AND actor_user_id=$3 AND phase='prepared'
          AND c.version=a.connection_version AND c.search_rank_sequence=a.connection_generation
          AND COALESCE((SELECT version FROM data.app_connector_credentials k WHERE k.connection_id=a.connection_id),0)=a.credential_version
          AND expires_at>clock_timestamp() AND NOT EXISTS (SELECT 1 FROM data.app_wecom_company_lifecycle l
            WHERE l.app_identity=$2 AND l.company_digest=a.company_digest AND l.changed_at>=a.started_at)
          LIMIT 1`, values: [digest, identity, actor], maxRows: 1 });
      if (!rows[0]) wecomDenied();
      await wecomAdmin(tx, String(rows[0].space_id), actor);
      const grant = validateWeComGrant(await wecomDecrypt(this.material, wecomAttemptOwner(rows[0]), 1, rows[0].encrypted_value_json) as unknown as WeComCompanyGrant);
      return { spaceId: String(rows[0].space_id), grant };
    });
  }
  /** Caller must have checked precisely these provider-visible members. Final CAS preserves old credentials until this commit. */
  async confirm(input: Request & { state: string; actorUserId: string; spaceId: string; members: readonly string[]; confirmed: true }) {
    if (input.confirmed !== true) wecomDenied();
    const digest = await state(input.state), identity = wecomAppIdentity(input.app), actor = text(input.actorUserId, "actorUserId");
    const spaceId = text(input.spaceId, "spaceId"), members = wecomMembers(input.members);
    const prepared = await this.prepared(input);
    if (prepared.spaceId !== spaceId) wecomDenied();
    const company = await wecomCompanyDigest(input.app, prepared.grant.corpId);
    await this.database.transaction({ requestId: text(input.requestId, "requestId", 200), operation: "app.wecom.install-confirm" }, async tx => {
      await lockWeComCompany(tx, identity, company);
      const snapshot = await wecomConnection(tx, `${spaceId}:wecom`); await wecomAdmin(tx, spaceId, actor);
      const rows = await tx.query<QueryResultRow>({ name: "wecom_install_confirm_lock_v1", text: `SELECT * FROM data.app_wecom_install_attempts a
        WHERE state_digest=$1 AND app_identity=$2 AND actor_user_id=$3 AND phase='prepared' AND expires_at>clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM data.app_wecom_company_lifecycle l WHERE l.app_identity=$2
            AND l.company_digest=$4 AND l.changed_at>=a.started_at) FOR UPDATE`, values: [digest, identity, actor, company], maxRows: 1 });
      const attempt = rows[0]; if (!attempt) wecomDenied(); unchanged(snapshot, attempt);
      const fresh = validateWeComGrant(await wecomDecrypt(this.material, wecomAttemptOwner(attempt), 1, attempt.encrypted_value_json) as unknown as WeComCompanyGrant);
      if (JSON.stringify(fresh) !== JSON.stringify(prepared.grant)) wecomDenied();
      const count = await tx.query<QueryResultRow>({ name: "wecom_company_install_bound_v1", text: `SELECT count(*) AS n FROM
        (SELECT 1 FROM data.app_wecom_installations WHERE app_identity=$1 AND company_digest=$2 AND connection_id<>$3 LIMIT 50) bounded`,
      values: [identity, company, `${spaceId}:wecom`], maxRows: 1 });
      if (Number(count[0]?.n) >= 50) wecomDenied();
      const previous = await tx.query<QueryResultRow>({ name: "wecom_install_previous_v1", text: `SELECT version FROM data.app_wecom_installations
        WHERE connection_id=$1 FOR UPDATE`, values: [`${spaceId}:wecom`], maxRows: 1 });
      const version = Number(previous[0]?.version ?? 0) + 1;
      const envelope = await wecomEncrypt(this.material, JSON.stringify([`${spaceId}:wecom`, identity, company, snapshot.generation]), version, { grant: fresh, members });
      await tx.query({ name: "wecom_install_save_v1", text: `INSERT INTO data.app_wecom_installations
        (connection_id,space_id,app_identity,company_digest,connection_generation,version,encrypted_value_json,started_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(connection_id) DO UPDATE SET app_identity=EXCLUDED.app_identity,
          company_digest=EXCLUDED.company_digest,connection_generation=EXCLUDED.connection_generation,version=EXCLUDED.version,
          encrypted_value_json=EXCLUDED.encrypted_value_json,started_at=EXCLUDED.started_at,confirmed_at=statement_timestamp(),grant_generation=gen_random_uuid()`,
      values: [`${spaceId}:wecom`, spaceId, identity, company, snapshot.generation, version, JSON.stringify(envelope), attempt.started_at], maxRows: 0 });
      await tx.query({ name: "wecom_install_manual_clear_v1", text: "DELETE FROM data.app_connector_credentials WHERE connection_id=$1",
        values: [`${spaceId}:wecom`], maxRows: 0 });
      await tx.query({ name: "wecom_install_activate_v1", text: `UPDATE data.app_connector_connections SET status='configured',error=NULL,
        version=version+1,last_checked_at=statement_timestamp(),updated_at=statement_timestamp() WHERE connection_id=$1`,
      values: [`${spaceId}:wecom`], maxRows: 0 });
      await tx.query({ name: "wecom_install_consume_v1", text: "DELETE FROM data.app_wecom_install_attempts WHERE state_digest=$1", values: [digest], maxRows: 0 });
    });
  }
}
