import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import { DatabaseContractError } from "./errors.js";

export type DingTalkCoordinationState = "preparing" | "commit_decided" | "abort_decided" | "committed" | "aborted";
export type DingTalkCoordination = { bindingDigest: string; effectId: string; binding: Record<string,unknown>; companyDigest: string;
  deadlineEpoch: number; leaderEpoch: number; state: DingTalkCoordinationState; sourcePrepared: boolean; targetPrepared: boolean;
  sourceProved: boolean; targetProved: boolean };
const decisions=new WeakSet<DingTalkCoordination>();
export function dingtalkJournalDecision(c: DingTalkCoordination) {
  if (!decisions.has(c)) throw new DatabaseContractError("foreign DingTalk journal decision");
}
async function decode(row: QueryResultRow): Promise<DingTalkCoordination> {
  if (await digestCanonicalCloneCborV1(row.binding_json)!==row.binding_digest) throw changed();
  const c: DingTalkCoordination={ bindingDigest: String(row.binding_digest),effectId: String(row.effect_id),binding: row.binding_json,
    companyDigest: String(row.company_digest),deadlineEpoch: new Date(row.decision_deadline).getTime(),
    leaderEpoch: Number(row.leader_epoch),state: row.state,sourcePrepared: !!row.source_prepared,targetPrepared: !!row.target_prepared,
    sourceProved: !!row.source_proved,targetProved: !!row.target_proved };
  if (["commit_decided","abort_decided"].includes(c.state)) decisions.add(c);return Object.freeze(c);
}
function stable(binding: Record<string,unknown>) {
  const job={ ...(binding.job as Record<string,unknown>) };delete job.leaseId;
  const destination={ ...(binding.destination as Record<string,unknown>) };delete destination.version;
  const value: Record<string,unknown>={ ...binding,job,destination };delete value.proofExpiresEpoch;
  return value;
}
function equal(a: unknown,b: unknown): boolean {
  if (a===b) return true;
  if (!a || !b || typeof a!=="object" || typeof b!=="object") return false;
  const ak=Object.keys(a),bk=Object.keys(b);
  return ak.length===bk.length && ak.every(k=>Object.hasOwn(b,k) && equal((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
}
const changed=()=>new DatabaseContractError("DingTalk coordination binding or leader changed");
/** Primary decision authority. None of its rows/indices/FKs are participant locks. */
export class DingTalkEffectJournal {
  constructor(private readonly database: AuthorityDatabase) {
    if (database.cacheMode!=="disabled") throw changed();
  }
  async reserve(input: Omit<DingTalkCoordination,"leaderEpoch" | "state" | "sourcePrepared" | "targetPrepared" | "sourceProved" | "targetProved">) {
    if (await digestCanonicalCloneCborV1(input.binding)!==input.bindingDigest) throw changed();
    return this.database.transaction({ requestId: crypto.randomUUID(),operation: "app.dingtalk.coordination-reserve" },async tx => {
      // This reservation lock is journal-only and released before preparation.
      await tx.query({ name: "dingtalk_journal_capacity_v1",text: "SELECT pg_advisory_xact_lock(hashtextextended('dingtalk-effect-journal',0))",maxRows: 1 });
      const prior=await tx.query({ name: "dingtalk_journal_prior_v1",text: "SELECT * FROM control.dingtalk_effect_journal WHERE effect_id=$1 ORDER BY created_at DESC,binding_digest DESC LIMIT 1 FOR UPDATE",
        values: [input.effectId],maxRows: 1 });
      if (prior[0]) {
        if (prior[0].binding_digest===input.bindingDigest) return { ...await decode(prior[0]),reused: true };
        if (!["committed","aborted"].includes(String(prior[0].state)) || !equal(stable(prior[0].binding_json),stable(input.binding))) throw changed();
        // A later lease may retry only the same stable intent. Old gate/decision
        // tombstones remain, and actual owners reauthorize before their replay.

      }
      const bounds=await tx.query({ name: "dingtalk_journal_bounds_v1",text: `SELECT
        $2::double precision>extract(epoch from clock_timestamp())*1000 AS fresh,
        (SELECT count(*) FROM (SELECT 1 FROM control.dingtalk_effect_journal LIMIT 10000) n) retained,
        (SELECT count(*) FROM (SELECT 1 FROM control.dingtalk_effect_journal WHERE state NOT IN ('committed','aborted') LIMIT 128) n) total,
        (SELECT count(*) FROM (SELECT 1 FROM control.dingtalk_effect_journal WHERE company_digest=$1 AND state NOT IN ('committed','aborted') LIMIT 8) n) company`,
        values: [input.companyDigest,input.deadlineEpoch],maxRows: 1 });
      if (!bounds[0]?.fresh || Number(bounds[0]?.retained)>=10000 || Number(bounds[0]?.total)>=128 || Number(bounds[0]?.company)>=8) throw changed();
      const rows=await tx.query({ name: "dingtalk_journal_reserve_v1",text: `INSERT INTO control.dingtalk_effect_journal
        (binding_digest,effect_id,binding_json,company_digest,decision_deadline,leader_until)
        VALUES($1,$2,$3::jsonb,$4,to_timestamp($5::double precision/1000),clock_timestamp()+interval '10 seconds') RETURNING *`,
        values: [input.bindingDigest,input.effectId,JSON.stringify(input.binding),input.companyDigest,input.deadlineEpoch],maxRows: 1 });
      return { ...await decode(rows[0]!),reused: false };
    });
  }
  async read(bindingDigest: string) {
    return this.database.transaction({ requestId: crypto.randomUUID(),operation: "app.dingtalk.coordination-read",statement: "single_read" },async tx => {
      const rows=await tx.query({ name: "dingtalk_journal_read_v1",text: "SELECT * FROM control.dingtalk_effect_journal WHERE binding_digest=$1",
        values: [bindingDigest],maxRows: 1 });
      if (!rows[0]) throw changed();return decode(rows[0]);
    });
  }
  private async update(operation: string,name: string,text: string,values: readonly unknown[]) {
    return this.database.transaction({ requestId: crypto.randomUUID(),operation },async tx => {
      const rows=await tx.query({ name,text,values,maxRows: 1 });
      if (!rows[0]) throw changed();return decode(rows[0]);
    });
  }
  async takeover(bindingDigest: string) {
    return this.update("app.dingtalk.coordination-takeover","dingtalk_journal_takeover_v1",`UPDATE control.dingtalk_effect_journal
      SET leader_epoch=leader_epoch+1,leader_until=clock_timestamp()+interval '10 seconds',updated_at=clock_timestamp()
      WHERE binding_digest=$1 AND leader_until<=clock_timestamp() AND state NOT IN ('committed','aborted') RETURNING *`,[bindingDigest]);
  }
  async prepared(c: DingTalkCoordination,participant: "source" | "target") {
    const field=participant==='source' ? 'source_prepared' : 'target_prepared';
    return this.update("app.dingtalk.coordination-vote","dingtalk_journal_vote_v1",`UPDATE control.dingtalk_effect_journal SET ${field}=true,updated_at=clock_timestamp()
      WHERE binding_digest=$1 AND leader_epoch=$2 AND leader_until>clock_timestamp() AND state='preparing' RETURNING *`,[c.bindingDigest,c.leaderEpoch]);
  }
  async decide(c: DingTalkCoordination,wanted: "commit" | "abort") {
    return this.database.transaction({ requestId: crypto.randomUUID(),operation: "app.dingtalk.coordination-decide" },async tx => {
      const locked=await tx.query({ name: "dingtalk_journal_decision_lock_v1",text: "SELECT * FROM control.dingtalk_effect_journal WHERE binding_digest=$1 FOR UPDATE",
        values: [c.bindingDigest],maxRows: 1 });
      if (!locked[0]) throw changed();
      const now=await decode(locked[0]);if (now.state!=='preparing') return now;
      const rows=await tx.query({ name: "dingtalk_journal_decide_v1",text: `UPDATE control.dingtalk_effect_journal SET
        state=CASE WHEN $3='commit' AND source_prepared AND target_prepared AND decision_deadline>clock_timestamp()
          THEN 'commit_decided' ELSE 'abort_decided' END,updated_at=clock_timestamp()
        WHERE binding_digest=$1 AND leader_epoch=$2 AND leader_until>clock_timestamp() RETURNING *`,
        values: [c.bindingDigest,c.leaderEpoch,wanted],maxRows: 1 });
      if (!rows[0]) throw changed();return decode(rows[0]);
    });
  }
  async proved(c: DingTalkCoordination,participant: "source" | "target") {
    dingtalkJournalDecision(c);
    const field=participant==='source' ? 'source_proved' : 'target_proved';
    return this.update("app.dingtalk.coordination-proof","dingtalk_journal_proof_v1",`UPDATE control.dingtalk_effect_journal SET ${field}=true,updated_at=clock_timestamp()
      WHERE binding_digest=$1 AND state=$2 AND state IN ('commit_decided','abort_decided') RETURNING *`,[c.bindingDigest,c.state]);
  }
  async terminal(c: DingTalkCoordination) {
    dingtalkJournalDecision(c);
    return this.update("app.dingtalk.coordination-terminal","dingtalk_journal_terminal_v1",`UPDATE control.dingtalk_effect_journal
      SET state=CASE WHEN state='commit_decided' THEN 'committed' ELSE 'aborted' END,updated_at=clock_timestamp()
      WHERE binding_digest=$1 AND state=$2 AND source_proved AND target_proved AND state IN ('commit_decided','abort_decided') RETURNING *`,[c.bindingDigest,c.state]);
  }
  async pending() {
    return this.database.transaction({ requestId: crypto.randomUUID(),operation: "app.dingtalk.coordination-pending",statement: "single_read" },async tx =>
      Promise.all((await tx.query({ name: "dingtalk_journal_pending_v1",text: `SELECT * FROM control.dingtalk_effect_journal
        WHERE state NOT IN ('committed','aborted') ORDER BY updated_at,binding_digest LIMIT 8`,maxRows: 8 })).map(decode)));
  }
}
