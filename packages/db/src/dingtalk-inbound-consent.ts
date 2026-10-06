import { lowercaseHex, sha256Hex } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import { appRequestText as text } from "./app-request-text.js";
import { dingtalkCompanyLock, dingtalkDenied, dingtalkPrimary, type DingTalkInstallation } from "./dingtalk-company-values.js";
import { dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import { dingtalkInboundLock, dingtalkInboundMaintain, dingtalkInboundOriginal, dingtalkInboundParent, dingtalkInboundParentFields, dingtalkInboundParentForSpace } from "./dingtalk-inbound-storage.js";
import { dingtalkInboundDecrypt, dingtalkInboundEncrypt, dingtalkInboundScope, dingtalkInboundScopeDigest,
  dingtalkInboundSelection, DINGTALK_INBOUND_DIGEST, type DingTalkInboundScope, type DingTalkInboundSelection } from "./dingtalk-inbound-values.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";

type Request = { requestId: string; app: DingTalkAppIdentity; actorUserId: string; spaceId: string };
type Attempt = Request & { state: string };
/**
 * Server-owned capability must prove current native company/app administrator,
 * selected member and this exact conversation before returning. No production
 * implementation or caller-selectable verifier exists yet.
 */
export type DingTalkConversationVerifier = (input: { installation: DingTalkInstallation; selection: DingTalkInboundSelection; signal: AbortSignal }) => Promise<DingTalkInboundScope>;
async function stateDigest(state: string) {
  if (!DINGTALK_INBOUND_DIGEST.test(state)) dingtalkDenied();
  return sha256Hex(state);
}

/** @dormant No production route records DingTalk inbound consent yet. */
export class PostgresDingTalkInboundConsentRepository {
  constructor(private readonly database: AuthorityDatabase, private readonly key: string) { dingtalkPrimary(database, key); }
  async begin(input: Request & { selection: DingTalkInboundSelection }) {
    const selection = dingtalkInboundSelection(input.selection), identity = dingtalkAppIdentity(input.app),
      state = lowercaseHex(crypto.getRandomValues(new Uint8Array(32))), digest = await stateDigest(state);
    const scope = await dingtalkInboundScopeDigest(selection), actor = text(input.actorUserId,"actorUserId");
    await dingtalkInboundMaintain(this.database,identity,text(input.requestId,"requestId",200));
    await this.database.transaction({ requestId: text(input.requestId,"requestId",200), operation: "app.dingtalk.inbound-begin" }, async tx => {
      await dingtalkInboundLock(tx,identity);
      const parent = await dingtalkInboundParentForSpace(tx,this.key,input.app,text(input.spaceId,"spaceId"));
      if (!parent || parent.installation.actorUserId !== actor || !parent.installation.members.includes(selection.memberId)) dingtalkDenied();
      const capacity = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_consent_capacity_v1", text: `SELECT
        (SELECT count(*) FROM (SELECT 1 FROM data.app_dingtalk_inbound_attempts WHERE app_identity=$1 LIMIT 10000) t) total,
        (SELECT count(*) FROM (SELECT 1 FROM data.app_dingtalk_inbound_attempts WHERE connection_id=$2 LIMIT 20) t) connection`,
        values: [identity,parent.installation.connectionId], maxRows: 1 });
      if (Number(capacity[0]?.total)>=10000 || Number(capacity[0]?.connection)>=20) dingtalkDenied();
      const expiry = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_consent_expiry_v1",
        text: "SELECT clock_timestamp()+interval '10 minutes' AS at",values: [],maxRows: 1 });
      const row = { ...dingtalkInboundParentFields(parent.row), state_digest: digest, scope_digest: scope,
        phase: "started", expires_at: expiry[0]!.at };
      const encrypted = await dingtalkInboundEncrypt(this.key,row,"attempt",selection);
      await tx.query({ name: "dingtalk_inbound_consent_write_v1", text: `INSERT INTO data.app_dingtalk_inbound_attempts
        (state_digest,connection_id,space_id,app_identity,company_digest,parent_generation,actor_user_id,
        actor_membership_generation,connection_generation,visibility_version,scope_digest,phase,expires_at,encrypted_value_json)
        VALUES ($1,$2,$3,$4,$5,$6::uuid,$7,$8,$9,$10,$11,'started',$12,$13::jsonb)`,
        values: [digest,row.connection_id,row.space_id,identity,row.company_digest,row.parent_generation,actor,
          row.actor_membership_generation,row.connection_generation,row.visibility_version,scope,row.expires_at,JSON.stringify(encrypted)], maxRows: 0 });
    });
    return { state };
  }
  private async attempt(tx: DatabaseTransaction, input: Attempt, phase: "started" | "taken") {
    const digest = await stateDigest(input.state), identity = dingtalkAppIdentity(input.app), actor = text(input.actorUserId,"actorUserId");
    const target = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_attempt_target_v1", text: `SELECT company_digest
      FROM data.app_dingtalk_inbound_attempts WHERE state_digest=$1 AND app_identity=$2 AND space_id=$3 AND actor_user_id=$4`,
      values: [digest,identity,text(input.spaceId,"spaceId"),actor],maxRows: 1 });
    if (!target[0]) dingtalkDenied();
    await dingtalkCompanyLock(tx,identity,String(target[0].company_digest));
    const rows = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_attempt_take_v1", text: `SELECT *
      FROM data.app_dingtalk_inbound_attempts WHERE state_digest=$1 AND app_identity=$2 AND actor_user_id=$3
        AND phase=$4 AND expires_at>clock_timestamp() FOR UPDATE`,values: [digest,identity,actor,phase],maxRows: 1 });
    const row = rows[0];
    if (!row || row.space_id!==input.spaceId) dingtalkDenied();
    const parent = await dingtalkInboundParent(tx,this.key,input.app,row);
    if (!parent) dingtalkDenied();
    const selection = dingtalkInboundSelection(await dingtalkInboundDecrypt(this.key,row,"attempt") as DingTalkInboundSelection);
    if (!parent.members.includes(selection.memberId) || await dingtalkInboundScopeDigest(selection)!==row.scope_digest) dingtalkDenied();
    return { row, parent, selection };
  }
  /** Spend original Human state before invoking the native capability. A failed verifier cannot replay it. */
  async confirm(input: Attempt & { confirmed: true }, verifyConversation: DingTalkConversationVerifier) {
    if (input.confirmed!==true || typeof verifyConversation!=="function") dingtalkDenied();
    const taken = await this.database.transaction({ requestId: text(input.requestId,"requestId",200), operation: "app.dingtalk.inbound-take" }, async tx => {
      const captured = await this.attempt(tx,input,"started");
      const row: QueryResultRow = { ...captured.row,phase: "taken" };
      const encrypted = await dingtalkInboundEncrypt(this.key,row,"attempt",captured.selection);
      await tx.query({ name: "dingtalk_inbound_attempt_spend_v1", text: `UPDATE data.app_dingtalk_inbound_attempts
        SET phase='taken',encrypted_value_json=$2::jsonb WHERE state_digest=$1`, values: [row.state_digest,JSON.stringify(encrypted)],maxRows: 0 });
      return { selection: captured.selection,installation: captured.parent };
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_,reject) => { timer = setTimeout(() => {
      controller.abort(); reject(new Error("DingTalk conversation verification expired"));
    },10000); });
    let scope: DingTalkInboundScope;
    try { scope = dingtalkInboundScope(await Promise.race([verifyConversation({ ...taken,signal: controller.signal }),expired])); }
    finally { clearTimeout(timer); controller.abort(); }
    const { verifierDigest: _verifier, ...selected } = scope;
    if (JSON.stringify(selected)!==JSON.stringify(taken.selection)) dingtalkDenied();
    return this.database.transaction({ requestId: text(input.requestId,"requestId",200), operation: "app.dingtalk.inbound-confirm" }, async tx => {
      await dingtalkInboundLock(tx,dingtalkAppIdentity(input.app));
      const { row } = await this.attempt(tx,input,"taken");
      const count = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_scope_capacity_v1",text: `SELECT
        (SELECT count(*) FROM (SELECT 1 FROM data.app_dingtalk_inbound_scopes WHERE app_identity=$1 LIMIT 10000) t) total,
        (SELECT count(*) FROM (SELECT 1 FROM data.app_dingtalk_inbound_scopes WHERE connection_id=$2 LIMIT 20) t) connection,
        EXISTS(SELECT 1 FROM data.app_dingtalk_inbound_scopes WHERE connection_id=$2 AND scope_digest=$3) present`,
        values: [row.app_identity,row.connection_id,row.scope_digest],maxRows: 1 });
      if (!count[0]?.present && (Number(count[0]?.total)>=10000 || Number(count[0]?.connection)>=20)) dingtalkDenied();
      const generation = crypto.randomUUID(), encrypted = await dingtalkInboundEncrypt(this.key,{ ...row,inbound_generation: generation },"scope",scope);
      await tx.query({ name: "dingtalk_inbound_scope_confirm_v1", text: `INSERT INTO data.app_dingtalk_inbound_scopes
        (connection_id,scope_digest,space_id,app_identity,company_digest,parent_generation,inbound_generation,actor_user_id,
        actor_membership_generation,connection_generation,visibility_version,encrypted_value_json)
        VALUES($1,$2,$3,$4,$5,$6::uuid,$7::uuid,$8,$9,$10,$11,$12::jsonb)
        ON CONFLICT(connection_id,scope_digest) DO UPDATE SET app_identity=EXCLUDED.app_identity,
        company_digest=EXCLUDED.company_digest,parent_generation=EXCLUDED.parent_generation,
        inbound_generation=EXCLUDED.inbound_generation,actor_user_id=EXCLUDED.actor_user_id,
        actor_membership_generation=EXCLUDED.actor_membership_generation,connection_generation=EXCLUDED.connection_generation,
        visibility_version=EXCLUDED.visibility_version,active=true,encrypted_value_json=EXCLUDED.encrypted_value_json,confirmed_at=clock_timestamp()`,
        values: [row.connection_id,row.scope_digest,row.space_id,row.app_identity,row.company_digest,row.parent_generation,generation,
          row.actor_user_id,row.actor_membership_generation,row.connection_generation,row.visibility_version,JSON.stringify(encrypted)],maxRows: 0 });
      await tx.query({ name: "dingtalk_inbound_attempt_finish_v1",text: "DELETE FROM data.app_dingtalk_inbound_attempts WHERE state_digest=$1",values: [row.state_digest],maxRows: 0 });
      return { scopeDigest: String(row.scope_digest),inboundGeneration: generation };
    });
  }
  async revoke(input: Request & { scopeDigest: string }) {
    if (!DINGTALK_INBOUND_DIGEST.test(input.scopeDigest)) dingtalkDenied();
    return this.database.transaction({ requestId: text(input.requestId,"requestId",200),operation: "app.dingtalk.inbound-revoke" }, async tx => {
      const parent = await dingtalkInboundParentForSpace(tx,this.key,input.app,text(input.spaceId,"spaceId"));
      if (!parent) dingtalkDenied();
      dingtalkInboundOriginal(parent.row,text(input.actorUserId,"actorUserId"));
      await tx.query({ name: "dingtalk_inbound_scope_revoke_v1",text: `UPDATE data.app_dingtalk_inbound_scopes
        SET active=false,encrypted_value_json='{}'::jsonb WHERE connection_id=$1 AND scope_digest=$2 AND app_identity=$3`,
        values: [parent.installation.connectionId,input.scopeDigest,dingtalkAppIdentity(input.app)],maxRows: 0 });
    });
  }
}
