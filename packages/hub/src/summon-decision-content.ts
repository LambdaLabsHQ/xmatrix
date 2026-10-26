import { createPostgresAuthorityDatabase, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";
import { PostgresChannelSpaceDirectory, PostgresContentRepository } from "@xmatrix/db";
import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import { DecisionEvidenceStepFailed, type DecisionEvidenceStage, type RoutingDecisionEvent, type RoutingEvaluator } from "./agent-routing-evaluation";
import { writeRestrictedRecord, RestrictedRecordWriteFailure } from "./restricted-record-content";
export { retryRestrictedRecordStep as retrySummonDecisionStep } from "./restricted-record-content";
import { retryRestrictedRecordStep as retrySummonDecisionStep } from "./restricted-record-content";

type DecisionContentAuthority = Pick<PostgresContentRepository, "createIntent" | "commitRef">;

/** Runs one evidence step and tags any failure with that step's category. */
async function evidenceStep<T>(stage: DecisionEvidenceStage, step: () => Promise<T>): Promise<T> {
  try { return await step(); }
  catch (error) {
    if (error instanceof DecisionEvidenceStepFailed) throw error;
    throw new DecisionEvidenceStepFailed(stage);
  }
}

/** Bound by the authenticated summon composition, never by model output. */
export function withSummonDecisionContent(input: {
  evaluate: RoutingEvaluator; content: DecisionContentAuthority; bucket: R2Bucket;
  actorUserId: string; channelId: string; sourceMessageId: string; invocationId: string;
}): RoutingEvaluator {
  const recordDecision = async (event: RoutingDecisionEvent) => {
    const refId = `decision:${event.decisionId}:${event.status}`;
    const payload = { version: 1, sourceMessageId: input.sourceMessageId, invocationId: input.invocationId,
      ...event, ...(event.status === "started" ? { inputDigest: await digestCanonicalCloneCborV1(event.input) } : {}) };
    try {
      await writeRestrictedRecord({ content: input.content, bucket: input.bucket,
        actorUserId: input.actorUserId, channelId: input.channelId, refId,
        ownerId: input.sourceMessageId, kind: "summon_decision", payload, maximumBytes: 128 * 1024 });
    } catch (error) {
      if (error instanceof RestrictedRecordWriteFailure) throw new DecisionEvidenceStepFailed(error.stage);
      throw error;
    }
  };
  return Object.assign(((request, options) => input.evaluate(request, options)) as RoutingEvaluator, { recordDecision });
}

/** Arms the Space cleanup clock before a write so stored evidence always has a wake. */
export function withDecisionClock(record: (event: RoutingDecisionEvent) => Promise<void>,
  resolveClock: () => Promise<{ arm(): Promise<void> }>): (event: RoutingDecisionEvent) => Promise<void> {
  let clock: Promise<{ arm(): Promise<void> }> | undefined;
  return async event => {
    clock ??= resolveClock();
    let target;
    try { target = await clock; }
    catch { clock = undefined; throw new DecisionEvidenceStepFailed("clock_resolve"); }
    await evidenceStep("clock_arm", () => retrySummonDecisionStep(() => target.arm()));
    await record(event);
    // The record is durable. This re-arm only covers an alarm that ran between the first arm and
    // the write and found nothing to keep; the next summon in the Space re-arms it. A failure here
    // must not reject a decision whose evidence is already stored.
    try { await retrySummonDecisionStep(() => target.arm()); }
    catch {
      console.error(JSON.stringify({ event: "summon_decision_clock_rearm_failed",
        decisionId: event.decisionId, phase: event.status }));
    }
  };
}

/** Production composition uses the same content authority and bucket as private uploads. */
export function summonDecisionEvaluator(env: PostgresAuthorityFleetEnv & { RELAY_PAYLOAD_BUCKET?: R2Bucket; RELAY_SUMMON_DECISION_CLOCK?: DurableObjectNamespace }, context: {
  evaluate: RoutingEvaluator; actorUserId: string; channelId: string; sourceMessageId: string; invocationId: string;
}): RoutingEvaluator {
  if (!env.RELAY_PAYLOAD_BUCKET || !env.RELAY_POSTGRES_SHARD_ID || !env.RELAY_SUMMON_DECISION_CLOCK) {
    return Object.assign(((request, options) => context.evaluate(request, options)) as RoutingEvaluator, {
      recordDecision: async () => { throw new DecisionEvidenceStepFailed("unconfigured"); },
    });
  }
  const database = createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-summon-evidence",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000 });
  const captured = withSummonDecisionContent({ ...context, bucket: env.RELAY_PAYLOAD_BUCKET,
    content: new PostgresContentRepository(database, env.RELAY_POSTGRES_SHARD_ID) });
  const namespace = env.RELAY_SUMMON_DECISION_CLOCK;
  captured.recordDecision = withDecisionClock(captured.recordDecision!, () =>
    retrySummonDecisionStep(() => new PostgresChannelSpaceDirectory(database).resolve({
      requestId: crypto.randomUUID(), operation: "decision.clock.resolve",
    }, context.channelId)).then(route => {
      if (!route) throw new Error("Decision Space is unavailable");
      const stub = namespace.get(namespace.idFromName(route.spaceId)) as unknown as { arm(spaceId: string): Promise<void> };
      return { arm: () => stub.arm(route.spaceId) };
    }));
  return captured;
}
