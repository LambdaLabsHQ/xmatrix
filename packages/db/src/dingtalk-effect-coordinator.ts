import { digestCanonicalCloneCborV1, sha256Hex } from "@xmatrix/protocol";
import type { AuthorityDatabase } from "./contracts.js";
import type { DingTalkAppIdentity } from "./dingtalk-suite-control.js";
import { dingtalkInboundHandle,type DingTalkInboundJob } from "./dingtalk-inbound-values.js";
import type { PostgresDingTalkInboundInboxRepository } from "./dingtalk-inbound-inbox.js";
import { createDingTalkPreparedEffectAuthority,dingtalkEffectId,type DingTalkEffectDestination,type DingTalkEffectAuthority } from "./dingtalk-effect-authority.js";
import { DingTalkEffectJournal,type DingTalkCoordination } from "./dingtalk-effect-journal.js";
import { DingTalkEffectParticipant } from "./dingtalk-effect-participant.js";
import { dingtalkPreparedPath,dingtalkPreparedPlan,type DingTalkPreparedPathCapability,type DingTalkPreparedPlan } from "./dingtalk-prepared-port.js";
import { PostgresSpacePlacementDirectory } from "./placement.js";
import { dingtalkEffectTargets } from "./dingtalk-effect-targets.js";
import { DatabaseContractError,DatabasePreparedUnknownError } from "./errors.js";

type Current=NonNullable<Awaited<ReturnType<PostgresDingTalkInboundInboxRepository["current"]>>>;
type Identity=Pick<DingTalkPreparedPlan,"shardId" | "databaseName" | "roleName">;
/** There is no production issuer until the native mode-specific verifier exists. */
export interface DingTalkCoordinationNativeProof { readonly verifierDigest: string }
const proofs=new WeakMap<DingTalkCoordinationNativeProof,{ jobDigest: string; expiresEpoch: number }>();
/** @dormant Reached only by tests until the native verifier exists. */
export async function dingtalkPrivateCoordinationProof(job: DingTalkInboundJob,verifierDigest: string,expiresEpoch: number) {
  if (!/^[a-f0-9]{64}$/u.test(verifierDigest) || !Number.isSafeInteger(expiresEpoch) || expiresEpoch<=Date.now())
    throw new DatabaseContractError("private native fixture proof is invalid");
  const proof=Object.freeze({ verifierDigest });proofs.set(proof,{ jobDigest: await digestCanonicalCloneCborV1(job),expiresEpoch });return proof;
}
type Owner={ database: AuthorityDatabase; identity: Identity; path?: DingTalkPreparedPathCapability };
const unavailable=()=>new DatabaseContractError("DingTalk cross-database coordination is unavailable");
/** Inactive internal coordinator. No public route, default path/native capability,
 * production recovery worker or environment toggle constructs this owner.
 * @dormant */
export class DingTalkEffectCoordinator {
  readonly journal: DingTalkEffectJournal;
  constructor(private readonly source: Owner,private readonly target: Owner,private readonly inbox: PostgresDingTalkInboundInboxRepository,
    private readonly app: DingTalkAppIdentity) {
    this.journal=new DingTalkEffectJournal(source.database);
  }
  private plan(digest: string,side: "s" | "t",owner: Owner) {
    const plan=dingtalkPreparedPlan({ ...owner.identity,gid: `xmatrix:dtfx:${digest}:1:${side}`,bindingDigest: digest,attemptEpoch: 1 });
    dingtalkPreparedPath(owner.path,plan);return plan;
  }
  private participants(c: DingTalkCoordination) {
    const source=this.plan(c.bindingDigest,"s",this.source),target=this.plan(c.bindingDigest,"t",this.target);
    if (JSON.stringify(c.binding.source)!==JSON.stringify(this.source.identity) || JSON.stringify(c.binding.target)!==JSON.stringify(this.target.identity)) {
      for (const [key,owner] of [["source",this.source],["target",this.target]] as const) {
        const expected=c.binding[key];
        if (!expected || typeof expected!=="object" || Object.entries(owner.identity).some(([k,v])=>(expected as Record<string,unknown>)[k]!==v)) throw unavailable();
      }
    }
    return { source: new DingTalkEffectParticipant(this.source.database,source,this.source.path!),
      target: new DingTalkEffectParticipant(this.target.database,target,this.target.path!) };
  }
  /** Candidate discovery at the target placement, never a copied primary ACL. */
  async destinations(job: DingTalkInboundJob,kind: "channel" | "automation") {
    this.plan("0".repeat(64),"t",this.target);dingtalkInboundHandle({ app: this.app,job });
    const sourceRef="dingtalk:inbound-"+await sha256Hex(JSON.stringify([job.connectionId,job.scopeDigest,job.inboundGeneration]));
    const placement=await new PostgresSpacePlacementDirectory(this.target.database).resolve({ requestId: crypto.randomUUID(),operation: "app.dingtalk.cross-target-discovery" },job.spaceId);
    return this.target.database.transaction({ requestId: crypto.randomUUID(),operation: "app.dingtalk.cross-target-candidates",
      placement: { spaceId: placement.spaceId,shardId: placement.shardId,placementEpoch: placement.placementEpoch } },tx=>dingtalkEffectTargets(tx,job,sourceRef,kind));
  }
  async execute(input: { job: DingTalkInboundJob; destination: DingTalkEffectDestination; proof: DingTalkCoordinationNativeProof;
    signal: AbortSignal; runTarget(database: AuthorityDatabase,authority: DingTalkEffectAuthority,current: Current): Promise<unknown> }) {
    // Missing path proof denies before any durable reservation or source read.
    this.plan("0".repeat(64),"s",this.source);this.plan("0".repeat(64),"t",this.target);
    const job=structuredClone(input.job),destination=structuredClone(input.destination),native=proofs.get(input.proof);
    if (input.signal.aborted || !native || native.jobDigest!==await digestCanonicalCloneCborV1(job)) throw unavailable();
    const discovered=await this.inbox.preparationBinding({ requestId: crypto.randomUUID(),app: this.app,job });
    const effectId=await dingtalkEffectId(job,destination),deadlineEpoch=Math.min(discovered.deadlineEpoch,native.expiresEpoch,Date.now()+20000);
    const binding={ job,destination,source: this.source.identity,target: this.target.identity,sourceBindingDigest: discovered.sourceBindingDigest,
      verifierDigest: input.proof.verifierDigest,proofExpiresEpoch: native.expiresEpoch };
    const bindingDigest=await digestCanonicalCloneCborV1(binding);
    const reserved=await this.journal.reserve({ bindingDigest,effectId,binding,companyDigest: discovered.companyDigest,deadlineEpoch });
    let c: DingTalkCoordination=reserved;
    if (reserved.reused) return this.recover(c.bindingDigest);
    const participants=this.participants(c);
    await participants.source.gate();await participants.target.gate();
    let current: Current | undefined,preparationFailure: unknown;
    try {
      current=await participants.source.prepare(async tx => {
        const value=await this.inbox.preparedSource(tx,{ requestId: crypto.randomUUID(),app: this.app,job });
        if (input.signal.aborted || value.sourceBindingDigest!==discovered.sourceBindingDigest ||
          value.scope.verifierDigest!==input.proof.verifierDigest || value.deadlineEpoch<deadlineEpoch) throw unavailable();
        return { ...value,deadlineEpoch };
      });
      if (!await participants.source.inventory()) throw unavailable();
      c=await this.journal.prepared(c,"source");
      const authority=await createDingTalkPreparedEffectAuthority({ job,destination,current,plan: participants.target.plan,signal: input.signal });
      try { await input.runTarget(participants.target.targetDatabase(authority),authority,current); }
      catch(error) { if (!(error instanceof DatabasePreparedUnknownError) || error.phase!=="prepare") throw error; }
      if (!await participants.target.inventory()) throw unavailable();
      c=await this.journal.prepared(c,"target");
      c=await this.journal.decide(c,input.signal.aborted ? "abort" : "commit");
    } catch(error) {
      preparationFailure=error;
      // No reverse transition is possible even if the decision's ACK was lost.
      // Source ACK loss without its private snapshot safely aborts this attempt.
      const actual=await this.journal.read(c.bindingDigest);
      c=actual.state==='preparing' ? await this.journal.decide(c,"abort") : actual;
      if (c.state==='preparing') throw error;
    }
    const resolved=await this.resolve(c);
    if (preparationFailure && resolved.state==='aborted') throw preparationFailure;
    return resolved;
  }
  /** A lost worker cannot reconstruct an uncommitted source snapshot. Abort an
   * undecided attempt under the current leader; decided effects only recover. */
  async recover(bindingDigest: string) {
    let c=await this.journal.read(bindingDigest);
    if (c.state==='preparing') {
      // A live leader must own its own decision; a recovery caller takes over
      // only after that epoch expires. It never guesses a commit from inventory.
      c=await this.journal.takeover(bindingDigest);c=await this.journal.decide(c,"abort");
    }
    return this.resolve(c);
  }
  private async resolve(c: DingTalkCoordination) {
    if (c.state==='committed' || c.state==='aborted') return c;
    const p=this.participants(c);
    if (c.state==='commit_decided') {
      await p.target.commit(c);c=await this.journal.proved(c,"target");
      await p.source.commit(c);c=await this.journal.proved(c,"source");
    } else if (c.state==='abort_decided') {
      await p.target.abort(c);c=await this.journal.proved(c,"target");
      await p.source.abort(c);c=await this.journal.proved(c,"source");
    } else throw unavailable();
    return this.journal.terminal(c);
  }
  async recoverBatch() {
    const outcomes=[];
    for (const c of await this.journal.pending()) {
      try { outcomes.push({ bindingDigest: c.bindingDigest,state: (await this.recover(c.bindingDigest)).state }); }
      catch { outcomes.push({ bindingDigest: c.bindingDigest,state: "recovery_required" }); }
    }
    return outcomes;
  }
}
