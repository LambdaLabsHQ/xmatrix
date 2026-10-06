import { dingtalkCompanyDigest, dingtalkCompanyLock, dingtalkDenied, dingtalkPrimary } from "./dingtalk-company-values.js";
import { dingtalkAppIdentity, type DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import { dingtalkInboundCleanup, dingtalkInboundLock, dingtalkInboundMaintain, dingtalkInboundParent } from "./dingtalk-inbound-storage.js";
import { dingtalkInboundBinding, dingtalkInboundCandidate, dingtalkInboundDecrypt, dingtalkInboundDigests, dingtalkInboundEncrypt,
  dingtalkInboundHandle, dingtalkInboundJob, dingtalkInboundScope, dingtalkInboundScopeDigest,
  type DingTalkInboundCandidate, type DingTalkInboundJob, type DingTalkInboundScope } from "./dingtalk-inbound-values.js";
import { AppControlError } from "./app-control.js";
import { appRequestText as text } from "./app-request-text.js";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import type { QueryResultRow } from "pg";
import { sha256Hex } from "@xmatrix/protocol";
import { createDingTalkEffectAuthority, type DingTalkEffectDestination } from "./dingtalk-effect-authority.js";
import { dingtalkTransactionPreparation } from "./dingtalk-prepared-port.js";
import { dingtalkEffectTargets } from "./dingtalk-effect-targets.js";

type Request = { requestId: string; app: DingTalkAppIdentity };
const unavailable = () => new AppControlError("dingtalk_inbound_capacity",503,"DingTalk inbound capacity reached",true);
/** Dormant primary owner. Only a future authenticated mode-specific adapter may call accept. */
export class PostgresDingTalkInboundInboxRepository {
  constructor(private readonly database: AuthorityDatabase,private readonly key: string) { dingtalkPrimary(database,key); }
  async accept(input: Request & { candidate: DingTalkInboundCandidate }) {
    const candidate = dingtalkInboundCandidate(input.candidate),identity = dingtalkAppIdentity(input.app),
      company = await dingtalkCompanyDigest(input.app,candidate.corpId), digests = await dingtalkInboundDigests(input.app,candidate),
      scopeDigest = await dingtalkInboundScopeDigest(candidate);
    await dingtalkInboundMaintain(this.database,identity,text(input.requestId,"requestId",200));
    return this.database.transaction({ requestId: text(input.requestId,"requestId",200),operation: "app.dingtalk.inbound-accept" },async tx => {
      await dingtalkInboundLock(tx,identity);
      await dingtalkCompanyLock(tx,identity,company);
      const prior = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_receipt_lookup_v1",text: `SELECT content_digest
        FROM data.app_dingtalk_inbound_receipts WHERE app_identity=$1 AND event_digest=$2 FOR SHARE`,values: [identity,digests.event],maxRows: 1 });
      if (prior[0]) {
        if (prior[0].content_digest!==digests.content) dingtalkDenied();
        return { reused: true,jobs: 0 };
      }
      const fresh = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_candidate_fresh_v1",text: `SELECT
        $1::bigint BETWEEN extract(epoch from clock_timestamp()-interval '24 hours')*1000
          AND extract(epoch from clock_timestamp()+interval '30 seconds')*1000 AS valid`,values: [candidate.createdAtMs],maxRows: 1 });
      if (!fresh[0]?.valid) dingtalkDenied();
      const targets = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_targets_v1",text: `SELECT s.* FROM data.app_dingtalk_inbound_scopes s
        WHERE s.app_identity=$1 AND s.company_digest=$2 AND s.scope_digest=$3 AND s.active
          AND extract(epoch from s.confirmed_at)*1000<=$4::bigint ORDER BY s.connection_id LIMIT 51 FOR SHARE`,
        values: [identity,company,scopeDigest,candidate.createdAtMs],maxRows: 51 });
      if (!targets.length || targets.length>50) dingtalkDenied();
      const eligible: QueryResultRow[] = [];
      for (const row of targets) {
        const parent = await dingtalkInboundParent(tx,this.key,input.app,row);
        if (!parent) continue;
        const scope = dingtalkInboundScope(await dingtalkInboundDecrypt(this.key,row,"scope") as DingTalkInboundScope);
        if (parent.corpId!==candidate.corpId || parent.appId!==candidate.appId || !parent.members.includes(candidate.memberId) ||
          scope.verifierDigest!==candidate.verifierDigest || await dingtalkInboundScopeDigest(scope)!==scopeDigest) dingtalkDenied();
        eligible.push(row);
      }
      if (!eligible.length) dingtalkDenied();
      const counts = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_backlog_v1",text: `SELECT
        (SELECT count(*) FROM (SELECT 1 FROM data.app_dingtalk_inbound_receipts WHERE app_identity=$1 LIMIT 10000) t) receipts,
        (SELECT count(*) FROM (SELECT 1 FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1 AND state IN ('pending','leased') LIMIT 10000) t) jobs`,
        values: [identity],maxRows: 1 });
      if (Number(counts[0]?.receipts)>=10000 || Number(counts[0]?.jobs)+eligible.length>10000) throw unavailable();
      for (const row of eligible) {
        const backlog = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_connection_backlog_v1",text: `SELECT count(*) n FROM
          (SELECT 1 FROM data.app_dingtalk_inbound_jobs WHERE connection_id=$1 AND state IN ('pending','leased') LIMIT 256) t`,
          values: [row.connection_id],maxRows: 1 });
        if (Number(backlog[0]?.n)>=256) throw unavailable();
      }
      await tx.query({ name: "dingtalk_inbound_receipt_insert_v1",text: `INSERT INTO data.app_dingtalk_inbound_receipts
        (app_identity,event_digest,company_digest,content_digest) VALUES ($1,$2,$3,$4)`,values: [identity,digests.event,company,digests.content],maxRows: 0 });
      for (const target of eligible) {
        const row: QueryResultRow = { ...target,event_digest: digests.event,content_digest: digests.content,payload_expires_epoch: candidate.createdAtMs+86400000 };
        const encrypted = await dingtalkInboundEncrypt(this.key,row,"job",candidate);
        await tx.query({ name: "dingtalk_inbound_job_insert_v1",text: `INSERT INTO data.app_dingtalk_inbound_jobs
          (app_identity,event_digest,connection_id,scope_digest,space_id,company_digest,parent_generation,inbound_generation,
          actor_user_id,actor_membership_generation,connection_generation,visibility_version,content_digest,payload_expires_epoch,encrypted_value_json)
          VALUES($1,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
          values: [identity,digests.event,row.connection_id,scopeDigest,row.space_id,company,row.parent_generation,row.inbound_generation,
            row.actor_user_id,row.actor_membership_generation,row.connection_generation,row.visibility_version,digests.content,row.payload_expires_epoch,JSON.stringify(encrypted)],maxRows: 0 });
      }
      return { reused: false,jobs: eligible.length };
    });
  }
  /** Claim returns opaque handles only. Private content is decrypted only after current source authorization. */
  async claim(input: Request): Promise<DingTalkInboundJob[]> {
    const identity = dingtalkAppIdentity(input.app);
    return this.database.transaction({ requestId: text(input.requestId,"requestId",200),operation: "app.dingtalk.inbound-claim" },async tx => {
      await dingtalkInboundLock(tx,identity);
      await dingtalkInboundCleanup(tx,identity);
      const active = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_active_leases_v1",text: `SELECT count(*) n FROM
        (SELECT 1 FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1 AND state='leased' AND lease_until>clock_timestamp() LIMIT 8) t`,
        values: [identity],maxRows: 1 });
      const slots = Math.max(0,8-Number(active[0]?.n));
      if (!slots) return [];
      const rows = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_claim_v1",text: `WITH due AS (SELECT
        app_identity,event_digest,connection_id,inbound_generation FROM data.app_dingtalk_inbound_jobs
        WHERE app_identity=$1 AND attempts<5 AND payload_expires_epoch>extract(epoch from clock_timestamp())*1000
          AND ((state='pending' AND available_at<=clock_timestamp()) OR (state='leased' AND lease_until<=clock_timestamp()))
        ORDER BY available_at,event_digest,connection_id LIMIT $2 FOR UPDATE SKIP LOCKED)
        UPDATE data.app_dingtalk_inbound_jobs j SET state='leased',attempts=attempts+1,lease_id=gen_random_uuid(),
          lease_until=clock_timestamp()+interval '30 seconds' FROM due d WHERE
          (j.app_identity,j.event_digest,j.connection_id,j.inbound_generation)=(d.app_identity,d.event_digest,d.connection_id,d.inbound_generation)
        RETURNING j.app_identity,j.event_digest,j.connection_id,j.space_id,j.scope_digest,j.parent_generation,j.inbound_generation,j.lease_id`,
        values: [identity,slots],maxRows: 8 });
      return rows.map(dingtalkInboundJob);
    });
  }
  /** Repeated at every effect boundary by a future scoped dispatcher. No route trusts a captured handle. */
  async current(input: Request & { job: DingTalkInboundJob }) {
    return this.database.transaction({ requestId: text(input.requestId,"requestId",200),operation: "app.dingtalk.inbound-current" },
      tx => this.currentTransaction(tx,input));
  }
  private async currentTransaction(tx: DatabaseTransaction,input: Request & { job: DingTalkInboundJob }) {
    const handle = dingtalkInboundHandle(input);
      const target = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_current_lock_v1",text: `SELECT company_digest
        FROM data.app_dingtalk_inbound_jobs WHERE app_identity=$1 AND event_digest=$2 AND connection_id=$3 AND inbound_generation=$4::uuid`,
        values: handle.slice(0,4),maxRows: 1 });
      if (!target[0]) return null;
      await dingtalkCompanyLock(tx,handle[0]!,String(target[0].company_digest));
      const receipts = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_current_receipt_v1",text: `SELECT *
        FROM data.app_dingtalk_inbound_receipts WHERE app_identity=$1 AND event_digest=$2 AND retain_until>clock_timestamp() FOR SHARE`,
        values: handle.slice(0,2),maxRows: 1 });
      if (!receipts[0]) return null;
      const jobs = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_current_job_v1",text: `SELECT * FROM data.app_dingtalk_inbound_jobs
        WHERE app_identity=$1 AND event_digest=$2 AND connection_id=$3 AND inbound_generation=$4::uuid
          AND state='leased' AND lease_id=$5::uuid AND lease_until>clock_timestamp()
          AND payload_expires_epoch>extract(epoch from clock_timestamp())*1000 FOR SHARE`,values: handle,maxRows: 1 });
      const row = jobs[0];
      if (!row || row.space_id!==input.job.spaceId || row.scope_digest!==input.job.scopeDigest || row.parent_generation!==input.job.parentGeneration ||
        row.content_digest!==receipts[0].content_digest || row.company_digest!==receipts[0].company_digest) return null;
      const parent = await dingtalkInboundParent(tx,this.key,input.app,row);
      if (!parent) return null;
      const scopes = await tx.query<QueryResultRow>({ name: "dingtalk_inbound_current_scope_v1",text: `SELECT * FROM data.app_dingtalk_inbound_scopes
        WHERE connection_id=$1 AND scope_digest=$2 AND inbound_generation=$3::uuid AND active FOR SHARE`,
        values: [row.connection_id,row.scope_digest,row.inbound_generation],maxRows: 1 });
      const selected = scopes[0];
      if (!selected || !await dingtalkInboundParent(tx,this.key,input.app,selected)) return null;
      const scope = dingtalkInboundScope(await dingtalkInboundDecrypt(this.key,selected,"scope") as DingTalkInboundScope),
        candidate = dingtalkInboundCandidate(await dingtalkInboundDecrypt(this.key,row,"job") as DingTalkInboundCandidate),
        digests = await dingtalkInboundDigests(input.app,candidate);
      if (await dingtalkInboundScopeDigest(scope)!==row.scope_digest || await dingtalkInboundScopeDigest(candidate)!==row.scope_digest ||
        scope.verifierDigest!==candidate.verifierDigest || parent.corpId!==candidate.corpId || parent.appId!==candidate.appId ||
        !parent.members.includes(candidate.memberId) || digests.event!==row.event_digest || digests.content!==row.content_digest ||
        candidate.createdAtMs+86400000!==Number(row.payload_expires_epoch)) dingtalkDenied();
      const sourceRef = "dingtalk:inbound-"+await sha256Hex(JSON.stringify([row.connection_id,row.scope_digest,row.inbound_generation]));
      const eventId = await sha256Hex(JSON.stringify([row.connection_id,row.inbound_generation,row.event_digest]));
      return { installation: parent,scope,candidate,sourceRef,eventId,actorMembershipGeneration: String(row.actor_membership_generation),
        deadlineEpoch: Math.min(new Date(row.lease_until).getTime(),Number(row.payload_expires_epoch)),sourceBindingDigest: await dingtalkInboundBinding(row) };
  }
  /** Discovery only; preparation revalidates this digest under native-source locks. */
  async preparationBinding(input: Request & { job: DingTalkInboundJob }) {
    const handle=dingtalkInboundHandle(input);
    return this.database.transaction({ requestId: text(input.requestId,"requestId",200),operation: "app.dingtalk.prepared-binding" },async tx => {
      const rows=await tx.query<QueryResultRow>({ name: "dingtalk_prepared_binding_v1",text: `SELECT * FROM data.app_dingtalk_inbound_jobs
        WHERE app_identity=$1 AND event_digest=$2 AND connection_id=$3 AND inbound_generation=$4::uuid
          AND state='leased' AND lease_id=$5::uuid AND lease_until>clock_timestamp()`,values: handle,maxRows: 1 });
      const row=rows[0];
      if (!row || row.space_id!==input.job.spaceId || row.scope_digest!==input.job.scopeDigest || row.parent_generation!==input.job.parentGeneration) dingtalkDenied();
      return { sourceBindingDigest: await dingtalkInboundBinding(row),companyDigest: String(row.company_digest),
        deadlineEpoch: Math.min(new Date(row.lease_until).getTime(),Number(row.payload_expires_epoch)) };
    });
  }
  /** Package-internal prepared participant, not a public/native ingress. */
  async preparedSource(tx: DatabaseTransaction,input: Request & { job: DingTalkInboundJob }) {
    if (!dingtalkTransactionPreparation(tx)?.gid.endsWith(":s")) dingtalkDenied();
    const current=await this.currentTransaction(tx,input);
    if (!current) dingtalkDenied();
    return current;
  }
  async finish(input: Request & { job: DingTalkInboundJob; outcome: "done" | "obsolete" | "retry" }) {
    const handle = dingtalkInboundHandle(input);
    if (!["done","obsolete","retry"].includes(input.outcome)) dingtalkDenied();
    return this.database.transaction({ requestId: text(input.requestId,"requestId",200),operation: "app.dingtalk.inbound-finish" },async tx => {
      const outcome = input.outcome==='done' && !await this.currentTransaction(tx,input) ? 'obsolete' : input.outcome;
      await tx.query({ name: "dingtalk_inbound_finish_v1",text: `UPDATE data.app_dingtalk_inbound_jobs SET
        state=CASE WHEN $6<>'retry' THEN $6 WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
        encrypted_value_json=CASE WHEN $6='retry' AND attempts<5 THEN encrypted_value_json ELSE '{}'::jsonb END,
        available_at=clock_timestamp()+make_interval(secs=>least(300,30*power(2,attempts-1))::int),lease_id=NULL,lease_until=NULL
        WHERE app_identity=$1 AND event_digest=$2 AND connection_id=$3 AND inbound_generation=$4::uuid
          AND lease_id=$5::uuid AND state='leased' AND lease_until>clock_timestamp()`,values: [...handle,outcome],maxRows: 0 });
    });
  }
  /** Dormant same-physical-database authority; no live adapter constructs this capability. */
  async effectAuthority(input: Request & { job: DingTalkInboundJob; destination: DingTalkEffectDestination; signal: AbortSignal }) {
    dingtalkInboundHandle(input);
    const captured={ ...input,app: { ...input.app },job: { ...input.job },destination: { ...input.destination } };
    const health=await this.database.health({ requestId: text(input.requestId,"requestId",200),operation: "app.dingtalk.effect-source-health" });
    if (!health.shardId || !await this.current(input) || input.signal.aborted) dingtalkDenied();
    return createDingTalkEffectAuthority({ job: captured.job,destination: captured.destination,primaryShardId: health.shardId,
      signal: captured.signal,source: tx => this.currentTransaction(tx,captured) });
  }
  /** Candidate enumeration does not substitute for actual-owner authorization. */
  async effectDestinations(input: Request & { job: DingTalkInboundJob; kind: "channel" | "automation" }) {
    dingtalkInboundHandle(input);
    return this.database.transaction({ requestId: text(input.requestId,"requestId",200),operation: "app.dingtalk.effect-candidates" },async tx => {
      const current=await this.currentTransaction(tx,input);
      if (!current) dingtalkDenied();
      return dingtalkEffectTargets(tx,input.job,current.sourceRef,input.kind);
    });
  }
  async maintain(input: Request) {
    await dingtalkInboundMaintain(this.database,dingtalkAppIdentity(input.app),text(input.requestId,"requestId",200));
  }
}
