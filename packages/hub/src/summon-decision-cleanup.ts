import type { PostgresContentRepository } from "@xmatrix/db";

type DecisionCollector = Pick<PostgresContentRepository,
  "retireDecisionUploads" | "expireDecisionRefs" | "dueDecisionObjects" | "claimDecisionObject" | "completeDecisionObject">;

/** Internal Space-scoped maintenance. PostgreSQL authorizes every deletion key;
 * a failed delete leaves a fenced lease for a later retry, never a live ref. */
export async function cleanupSummonDecisions(input: {
  content: DecisionCollector; bucket: Pick<R2Bucket, "delete">; spaceId: string; deleteTimeoutMs?: number;
}): Promise<{ retiredUploads: number; expired: number; deleted: number; deferred: number }> {
  const deleteTimeoutMs = input.deleteTimeoutMs ?? 5_000;
  if (!Number.isInteger(deleteTimeoutMs) || deleteTimeoutMs < 1 || deleteTimeoutMs > 5_000) throw new Error("Invalid deletion timeout");
  const requestId = () => crypto.randomUUID();
  const retiredUploads = await input.content.retireDecisionUploads({ requestId: requestId(), spaceId: input.spaceId, limit: 50 });
  const { expired } = await input.content.expireDecisionRefs({ requestId: requestId(), spaceId: input.spaceId, limit: 50 });
  const keys = await input.content.dueDecisionObjects({ requestId: requestId(), spaceId: input.spaceId, limit: 10 });
  let deleted = 0, deferred = 0;
  for (const objectKey of keys) {
    const lease = await input.content.claimDecisionObject({ requestId: requestId(), spaceId: input.spaceId, objectKey });
    if (!lease) { deferred++; continue; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([input.bucket.delete(lease.objectKey), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Decision deletion timed out")), deleteTimeoutMs);
      })]);
      if (await input.content.completeDecisionObject({ requestId: requestId(), spaceId: input.spaceId,
        objectId: lease.objectId, version: lease.version })) deleted++;
      else deferred++;
    } catch (error) {
      console.warn("Summon decision cleanup deferred", { error: error instanceof Error ? error.message : String(error) });
      deferred++;
    }
    finally { if (timer) clearTimeout(timer); }
  }
  return { retiredUploads, expired, deleted, deferred };
}
