import type { AuthorityDatabase, AuthorityDatabaseSession, DatabaseTransaction } from "./contracts.js";
import type { DatabaseRequestContext } from "./context.js";
import { DatabaseContractError } from "./errors.js";

/** Internal manager identity. Neither command metadata nor an arbitrary GID is authority. */
export type DingTalkPreparedPlan = Readonly<{ gid: string; bindingDigest: string; shardId: string;
  databaseName: string; roleName: string; attemptEpoch: number }>;
export type DingTalkPreparedDecision = Readonly<{ outcome: "commit" | "abort" }>;
export type DingTalkPreparedPort = {
  inspect(context: DatabaseRequestContext,plan: DingTalkPreparedPlan): Promise<boolean>;
  resolve(context: DatabaseRequestContext,decision: DingTalkPreparedDecision): Promise<"resolved" | "missing">;
};
/** No production evidence issuer is registered. Private direct tests must supply
 * their exact role/database/path record; a Hyperdrive label never admits work. */
export type DingTalkPreparedPathEvidence = Readonly<{ pathId: string; shardId: string; databaseName: string; roleName: string;
  twoPhase: true; retainedSerialization: true; recoveryOwner: string; evidenceDigest: string }>;
export interface DingTalkPreparedPathCapability { readonly pathId: string }
const paths=new WeakMap<DingTalkPreparedPathCapability,DingTalkPreparedPathEvidence>();
/** @dormant Reached only by tests until a prepared path is provisioned. */
export function dingtalkPrivatePreparedPath(evidence: DingTalkPreparedPathEvidence): DingTalkPreparedPathCapability {
  if (!evidence.pathId.startsWith("private-test-direct:") || evidence.twoPhase!==true || evidence.retainedSerialization!==true ||
    !evidence.recoveryOwner || !/^[a-f0-9]{64}$/u.test(evidence.evidenceDigest))
    throw new DatabaseContractError("DingTalk prepared path evidence is unavailable");
  const cap=Object.freeze({ pathId: evidence.pathId });paths.set(cap,Object.freeze({ ...evidence }));return cap;
}
export function dingtalkPreparedPath(capability: DingTalkPreparedPathCapability | undefined,plan: DingTalkPreparedPlan) {
  const path=capability && paths.get(capability);
  if (!path || path.shardId!==plan.shardId || path.databaseName!==plan.databaseName || path.roleName!==plan.roleName)
    throw new DatabaseContractError("DingTalk prepared path admission is unknown or mismatched");
  return path;
}
const transactions=new WeakMap<DatabaseTransaction,DingTalkPreparedPlan>();
export function registerDingTalkPreparedTransaction(tx: DatabaseTransaction,plan: DingTalkPreparedPlan) { transactions.set(tx,plan); }
export function dingtalkTransactionPreparation(tx: DatabaseTransaction) { return transactions.get(tx); }
const contexts=new WeakMap<DatabaseRequestContext,DingTalkPreparedPlan>();
const decisions=new WeakMap<DingTalkPreparedDecision,{ plan: DingTalkPreparedPlan; outcome: "commit" | "abort" }>();
const ports=new WeakMap<AuthorityDatabaseSession,DingTalkPreparedPort>();

export function dingtalkPreparedPlan(value: DingTalkPreparedPlan): DingTalkPreparedPlan {
  if (!/^xmatrix:dtfx:[a-f0-9]{64}:[1-9][0-9]{0,11}:[st]$/u.test(value.gid) ||
    !/^[a-f0-9]{64}$/u.test(value.bindingDigest) || !Number.isSafeInteger(value.attemptEpoch) || value.attemptEpoch<1 ||
    value.attemptEpoch>999999999999 || value.gid.split(':')[3]!==String(value.attemptEpoch) || value.gid.split(':')[2]!==value.bindingDigest ||
    [value.shardId,value.databaseName,value.roleName].some(v=>typeof v!=="string" || !v || v.length>300))
    throw new DatabaseContractError("invalid DingTalk prepared participant plan");
  return Object.freeze({ ...value });
}
/** The coordinator calls this only after resolving a matching durable local gate. */
export function dingtalkPrepareContext(context: DatabaseRequestContext,plan: DingTalkPreparedPlan,capability?: DingTalkPreparedPathCapability) {
  dingtalkPreparedPath(capability,plan);
  if (context.statement) throw new DatabaseContractError("a DingTalk preparation cannot be a single read");
  const prepared=Object.freeze({ ...context });contexts.set(prepared,dingtalkPreparedPlan(plan));return prepared;
}
export function dingtalkPreparation(context: DatabaseRequestContext) { return contexts.get(context); }
/** Issued by journal resolution, never from caller-supplied metadata. Not exported by the public DB entrypoint. */
export function dingtalkPreparedDecision(plan: DingTalkPreparedPlan,outcome: "commit" | "abort",capability?: DingTalkPreparedPathCapability): DingTalkPreparedDecision {
  dingtalkPreparedPath(capability,plan);
  if (!["commit","abort"].includes(outcome)) throw new DatabaseContractError("invalid prepared decision");
  const decision=Object.freeze({ outcome });decisions.set(decision,{ plan: dingtalkPreparedPlan(plan),outcome });return decision;
}
export function dingtalkDecision(decision: DingTalkPreparedDecision) {
  const grant=decisions.get(decision);if(!grant)throw new DatabaseContractError("foreign prepared decision");return grant;
}
export function registerDingTalkPreparedPort(session: AuthorityDatabaseSession,port: DingTalkPreparedPort) { ports.set(session,port); }
export async function withDingTalkPreparedPort<T>(database: AuthorityDatabase,run: (port: DingTalkPreparedPort)=>Promise<T>) {
  const session=database.openSession();
  try {const port=ports.get(session);if(!port)throw new DatabaseContractError("prepared driver is unavailable");return await run(port);}
  finally {await session.close();}
}
