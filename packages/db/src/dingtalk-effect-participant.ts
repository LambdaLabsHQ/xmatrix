import type { AuthorityDatabase, AuthorityDatabaseSession, DatabaseTransaction } from "./contracts.js";
import type { DatabaseRequestContext } from "./context.js";
import { DatabaseContractError, DatabasePreparedUnknownError } from "./errors.js";
import { dingtalkPreparedDecision, dingtalkPreparedPath, dingtalkPrepareContext, withDingTalkPreparedPort,
  type DingTalkPreparedPathCapability, type DingTalkPreparedPlan } from "./dingtalk-prepared-port.js";
import { dingtalkPreparedEffectComplete, type DingTalkEffectAuthority } from "./dingtalk-effect-authority.js";
import { dingtalkJournalDecision,type DingTalkCoordination } from "./dingtalk-effect-journal.js";
const denied=()=>new DatabaseContractError("DingTalk participant gate or binding changed");
const context=(operation: string) => ({ requestId: crypto.randomUUID(),operation });
/** Narrow local manager. It never consumes caller SQL or arbitrary recovery GIDs. */
export class DingTalkEffectParticipant {
  constructor(readonly database: AuthorityDatabase,readonly plan: DingTalkPreparedPlan,
    private readonly path: DingTalkPreparedPathCapability) {
    dingtalkPreparedPath(path,plan);if (database.cacheMode!=="disabled") throw denied();
  }
  async gate() {
    return this.database.transaction(context("app.dingtalk.participant-gate"),async tx => {
      await tx.query({ name: "dingtalk_participant_gate_insert_v1",text: `INSERT INTO control.dingtalk_effect_gates(gid,binding_digest,plan_json)
        VALUES($1,$2,$3::jsonb) ON CONFLICT(gid) DO NOTHING`,values: [this.plan.gid,this.plan.bindingDigest,JSON.stringify(this.plan)],maxRows: 0 });
      await this.lockGate(tx);
    });
  }
  private async lockGate(tx: DatabaseTransaction,closing=false) {
    const rows=await tx.query({ name: "dingtalk_participant_gate_lock_v1",text: "SELECT * FROM control.dingtalk_effect_gates WHERE gid=$1 FOR UPDATE",
      values: [this.plan.gid],maxRows: 1 });
    const row=rows[0];
    if (!row || row.binding_digest!==this.plan.bindingDigest || !row.plan_json ||
      Object.keys(row.plan_json).length!==Object.keys(this.plan).length ||
      Object.entries(this.plan).some(([key,value])=>row.plan_json[key]!==value)) throw denied();
    if (row.closed && !closing) throw denied();
  }
  private async outcome(tx: DatabaseTransaction) {
    await tx.query({ name: "dingtalk_participant_outcome_v1",text: `INSERT INTO control.dingtalk_effect_outcomes(gid,binding_digest,outcome)
      VALUES($1,$2,'committed')`,values: [this.plan.gid,this.plan.bindingDigest],maxRows: 0 });
  }
  async prepare<T>(run: (tx: DatabaseTransaction)=>Promise<T>,rawContext=context("app.dingtalk.participant-prepare")) {
    return this.database.transaction(dingtalkPrepareContext(rawContext,this.plan,this.path),async tx => {
      await this.lockGate(tx);const result=await run(tx);await this.outcome(tx);return result;
    });
  }
  /** The adapter still invokes the real repository. Only its final placed write
   * is transformed to PREPARE; sequence reservation/discovery stay ordinary. */
  targetDatabase(authority: DingTalkEffectAuthority): AuthorityDatabase {
    let used=false;
    const wrap=<T>(database: AuthorityDatabase,rawContext: DatabaseRequestContext,run: (tx: DatabaseTransaction)=>Promise<T>): Promise<T> => {
      if (rawContext.statement || !rawContext.placement || !["message.append","automation.trigger"].includes(rawContext.operation))
        return database.transaction(rawContext,run);
      if (used) throw denied();used=true;
      return database.transaction(dingtalkPrepareContext(rawContext,this.plan,this.path),async tx => {
        await this.lockGate(tx);const result=await run(tx);
        if (!dingtalkPreparedEffectComplete(tx,authority)) throw denied();
        await this.outcome(tx);return result;
      });
    };
    const session=(raw: AuthorityDatabaseSession): AuthorityDatabaseSession => ({ cacheMode: "disabled",
      openSession: ()=>session(raw.openSession()),transaction: (c,r)=>wrap(raw,c,r),health: c=>raw.health(c),close: ()=>raw.close() });
    return { cacheMode: "disabled",openSession: ()=>session(this.database.openSession()),
      transaction: (c,r)=>wrap(this.database,c,r),health: c=>this.database.health(c) };
  }
  async inventory() {
    return withDingTalkPreparedPort(this.database,port=>port.inspect(context("app.dingtalk.participant-inventory"),this.plan));
  }
  async receipt() {
    // Identity is verified even when an inventory row is absent. Outcome alone
    // is not a product-content/public-replay capability.
    await this.inventory();
    return this.database.transaction({ ...context("app.dingtalk.participant-receipt"),statement: "single_read" },async tx => {
      const rows=await tx.query({ name: "dingtalk_participant_receipt_v1",text: "SELECT binding_digest,outcome FROM control.dingtalk_effect_outcomes WHERE gid=$1",
        values: [this.plan.gid],maxRows: 1 });
      if (!rows.length) return false;
      if (rows[0]?.binding_digest!==this.plan.bindingDigest || rows[0]?.outcome!=="committed") throw denied();
      return true;
    });
  }
  private checkDecision(c: DingTalkCoordination,outcome: "commit" | "abort") {
    dingtalkJournalDecision(c);
    if (c.bindingDigest!==this.plan.bindingDigest || c.state!==`${outcome}_decided` ||
      (outcome==='commit' && this.plan.gid.endsWith(':s') && !c.targetProved)) throw denied();
    return dingtalkPreparedDecision(this.plan,outcome,this.path);
  }
  async commit(c: DingTalkCoordination) {
    const decision=this.checkDecision(c,"commit");
    if (!await this.receipt()) {
      try { await withDingTalkPreparedPort(this.database,port=>port.resolve(context("app.dingtalk.participant-commit"),decision)); }
      catch(error) { if (!(error instanceof DatabasePreparedUnknownError)) throw error; }
    }
    if (!await this.receipt()) throw new DatabaseContractError("DingTalk committed participant requires recovery");
  }
  async abort(c: DingTalkCoordination) {
    const decision=this.checkDecision(c,"abort");
    // A gate row cannot disappear: no TTL/FK cleanup exists. The closure waiter
    // serializes with active execution, including PREPARE arriving after a scan.
    let settled=false,failure: unknown;
    const close=this.database.transaction(context("app.dingtalk.participant-close"),async tx => {
      await tx.query({ name: "dingtalk_participant_close_create_v1",text: `INSERT INTO control.dingtalk_effect_gates(gid,binding_digest,plan_json,closed)
        VALUES($1,$2,$3::jsonb,true) ON CONFLICT(gid) DO NOTHING`,values: [this.plan.gid,this.plan.bindingDigest,JSON.stringify(this.plan)],maxRows: 0 });
      await this.lockGate(tx,true);
      await tx.query({ name: "dingtalk_participant_close_v1",text: "UPDATE control.dingtalk_effect_gates SET closed=true WHERE gid=$1",
        values: [this.plan.gid],maxRows: 0 });
    }).then(()=>{settled=true;},error=>{failure=error;settled=true;});
    const until=Date.now()+2500;
    while (!settled && Date.now()<until) {
      if (await this.inventory()) {
        try { await withDingTalkPreparedPort(this.database,port=>port.resolve(context("app.dingtalk.participant-abort"),decision)); }
        catch(error) { if (!(error instanceof DatabasePreparedUnknownError)) { await close;throw error; } }
      }
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await close;if (failure) throw failure;
    if (await this.inventory() || await this.receipt()) throw denied();
  }
}
