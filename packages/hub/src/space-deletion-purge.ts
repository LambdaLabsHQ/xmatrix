import type { PostgresSpaceControlRepository } from "@xmatrix/db";

type SpacePurger = Pick<PostgresSpaceControlRepository, "purgeSpaceStep" | "recordSpacePurgeObjects">;

const RETRY_SOON_MS = 1_000;

/**
 * Runs bounded purge steps for one deleted Space until the work or the time
 * budget runs out. PostgreSQL decides what is due and records every step, so
 * an interrupted run resumes where the last committed step ended. Returns the
 * next wake time, or null when nothing is left to do for this Space.
 */
export async function purgeDeletedSpace(input: {
  spaces: SpacePurger;
  bucket: Pick<R2Bucket, "delete">;
  spaceId: string;
  budgetMs?: number;
  deleteTimeoutMs?: number;
  now?: () => number;
}): Promise<{ nextAt: number | null; rows: number; objects: number }> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? 20_000);
  const deleteTimeoutMs = input.deleteTimeoutMs ?? 10_000;
  let rows = 0, objects = 0;
  while (now() < deadline) {
    const at = new Date(now()).toISOString();
    const step = await input.spaces.purgeSpaceStep({ requestId: crypto.randomUUID(), spaceId: input.spaceId, now: at });
    if (step.status === "absent" || step.status === "completed") return { nextAt: null, rows, objects };
    if (step.status === "restorable") return { nextAt: Date.parse(step.purgeAfter), rows, objects };
    if (step.status === "rows") { rows += step.purgedRows; continue; }
    if (step.status === "objects") {
      if (step.objectKeys.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([input.bucket.delete(step.objectKeys), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Space object deletion timed out")), deleteTimeoutMs);
          })]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      await input.spaces.recordSpacePurgeObjects({ requestId: crypto.randomUUID(), spaceId: input.spaceId,
        cursor: step.cursor, exhausted: step.exhausted, deleted: step.objectKeys.length, now: at });
      objects += step.objectKeys.length;
    }
  }
  return { nextAt: now() + RETRY_SOON_MS, rows, objects };
}
