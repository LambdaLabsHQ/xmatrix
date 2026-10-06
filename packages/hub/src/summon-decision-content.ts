import { createPostgresAuthorityDatabase, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";
import { PostgresChannelSpaceDirectory, PostgresContentRepository } from "@xmatrix/db";
import { digestCanonicalCloneCborV1, immutableContentObjectKey, restrictedChannelContentScope, sha256Hex } from "@xmatrix/protocol";
import { DecisionEvidenceStepFailed, type DecisionEvidenceStage, type RoutingDecisionEvent, type RoutingEvaluator } from "./agent-routing-evaluation";
import { cloudflareRelayPrivateR2UploadPort } from "./relay-r2-upload-private-api";
import { executeRelayR2UploadGatewayRequest, RELAY_R2_UPLOAD_CHECKSUM_HEADER } from "./relay-r2-upload-gateway";

type DecisionContentAuthority = Pick<PostgresContentRepository, "createIntent" | "commitRef">;

/** Every retry repeats one idempotent step with identical authority inputs. */
export async function retrySummonDecisionStep<T>(step: () => Promise<T>): Promise<T> {
  try { return await step(); }
  catch (error) {
    console.warn("Summon decision step retried", { error: error instanceof Error ? error.message : String(error) });
    await new Promise(resolve => setTimeout(resolve, 100));
    return step();
  }
}

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
  const scopeId = restrictedChannelContentScope(input.channelId, input.actorUserId);
  const principal = { kind: "user" as const, id: input.actorUserId };
  const recordDecision = async (event: RoutingDecisionEvent) => {
    const refId = `decision:${event.decisionId}:${event.status}`;
    const payload = { version: 1, sourceMessageId: input.sourceMessageId, invocationId: input.invocationId,
      ...event, ...(event.status === "started" ? { inputDigest: await digestCanonicalCloneCborV1(event.input) } : {}) };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (bytes.byteLength > 128 * 1024) throw new DecisionEvidenceStepFailed("oversize");
    const checksum = await sha256Hex(bytes);
    const objectKey = immutableContentObjectKey(scopeId, checksum);
    const now = Date.now();
    const intentId = `intent:${refId}`;
    const intent = { requestId: refId, commandId: `create:${refId}`, intentId,
      scopeId, purpose: "summon_decision", contentHash: checksum, encodedBytes: bytes.byteLength,
      expiresAt: new Date(now + 15 * 60_000).toISOString(), principal } as const;
    await evidenceStep("intent", () => retrySummonDecisionStep(() => input.content.createIntent(intent)));
    await evidenceStep("upload", () => retrySummonDecisionStep(() => executeRelayR2UploadGatewayRequest({
      request: new Request("https://internal/api/relay-v2/private-r2/upload", { method: "PUT", body: bytes,
        headers: { "content-length": String(bytes.byteLength), [RELAY_R2_UPLOAD_CHECKSUM_HEADER]: checksum } }),
      now, visibilityScopeId: scopeId,
      intent: { intentId, visibilityScopeId: scopeId, contentHash: checksum, checksumSha256: checksum,
        encodedSize: bytes.byteLength, finalKey: objectKey, expiresAt: now + 15 * 60_000,
        state: "pending", allowStaging: false },
      bucket: cloudflareRelayPrivateR2UploadPort(input.bucket),
    })));
    const committed = { requestId: refId, commandId: `commit:${refId}`, intentId,
      expectedIntentVersion: 1, refId, ownerKind: "summon_decision", ownerId: input.sourceMessageId,
      scopeId, objectKey, checksum, encodedBytes: bytes.byteLength,
      verifiedAt: new Date().toISOString(), principal };
    await evidenceStep("commit", () => retrySummonDecisionStep(() => input.content.commitRef(committed)));
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
