import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "@xmatrix/protocol";
import type { PostgresContentRepository } from "@xmatrix/db";
import type { Env } from "../types";

/*
 * Providers whose terms bound how long their results may be stored
 * (`resultRetentionDays`). The Space's retention clock (the one that expires
 * private connector results and summon decisions) deletes what they returned
 * at that age, and everything at once after the connection is disconnected:
 * it is armed when such a provider authors a message and when its connection
 * is disconnected, and re-arms itself for the next due result.
 */

export const RETAINED_APP_RESULTS: ReadonlyMap<string, number> = new Map(APP_CONNECTOR_PROVIDER_MANIFESTS.flatMap(
  (manifest) => manifest.resultRetentionDays ? [[manifest.id, manifest.resultRetentionDays] as const] : []));

const BATCH = 50;
const BATCHES_PER_PASS = 4;

type Retention = Pick<PostgresContentRepository, "expireAppResults" | "nextAppResultsExpiry">;

export async function expireRetainedAppResults(content: Retention, spaceId: string,
  providers: ReadonlyMap<string, number> = RETAINED_APP_RESULTS): Promise<{ expired: Record<string, number>; next: number | null }> {
  const expired: Record<string, number> = {};
  let next: number | null = null;
  for (const [appId, retentionDays] of providers) {
    let total = 0;
    for (let batch = 0; batch < BATCHES_PER_PASS; batch++) {
      const pass = await content.expireAppResults({ requestId: crypto.randomUUID(), spaceId, appId, retentionDays, limit: BATCH });
      total += pass.messages + pass.executions + pass.refs;
      if (pass.messages < BATCH && pass.executions < BATCH && pass.refs < BATCH) break;
    }
    if (total) expired[appId] = total;
    const due = await content.nextAppResultsExpiry({ requestId: crypto.randomUUID(), spaceId, appId, retentionDays });
    if (due !== null) next = next === null ? due : Math.min(next, due);
  }
  return { expired, next };
}

/** Start the Space's retention clock when a retained provider's results change. */
export async function armAppResultRetention(env: Env, spaceId: string, appId: string): Promise<void> {
  if (!RETAINED_APP_RESULTS.has(appId) || !env.RELAY_SUMMON_DECISION_CLOCK) return;
  const clock = env.RELAY_SUMMON_DECISION_CLOCK.get(env.RELAY_SUMMON_DECISION_CLOCK.idFromName(spaceId)) as unknown as {
    arm(spaceId: string): Promise<void>;
  };
  await clock.arm(spaceId);
}
