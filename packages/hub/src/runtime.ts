import { createJevClient } from "@xmatrix/decision-model";
import { observeRegistrationQuota, PostgresRuntimeRepository, type AuthorityDatabase } from "@xmatrix/db";

import type { AppConnectorEnv } from "./app-connectors";
import { refreshAgentRoutingQuota, registrationQuotaProbeTargetReader } from "./agent-routing-quota-refresh";
import {
  createPostgresAuthorityDatabase,
  createPostgresAuthorityFleet,
  type PostgresAuthorityFleetEnv,
} from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import type { RoutingEvaluator } from "./agent-routing-evaluation";
import { boundedOccurrenceAt } from "./bounded-occurrence-time";
import { summonDecisionEvaluator } from "./summon-decision-content";
import type { Env } from "./types";

/** What Runs, Instances and their launches need from the Worker. */
export interface RuntimeEnv extends PostgresAuthorityFleetEnv, AppConnectorEnv {
  RELAY_PAYLOAD_BUCKET?: R2Bucket;
  RELAY_SUMMON_DECISION_CLOCK?: DurableObjectNamespace;
  JEV_AI_GATEWAY_API_KEY?: string;
}

/** The Space shards Runs and Instances live on. */
export function runtimeDatabase(env: PostgresAuthorityFleetEnv): AuthorityDatabase {
  return createPostgresAuthorityDatabase(env, { applicationName: "xmatrix-hub-runtime", ...POSTGRES_AUTHORITY_TIMEOUTS });
}

/** The directory that places Spaces and holds registrations, beside the runtime shards. */
export function runtimeDirectory(env: PostgresAuthorityFleetEnv): AuthorityDatabase {
  return createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-runtime-directory", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }).directoryDatabase;
}

export function runtimeRepository(
  env: PostgresAuthorityFleetEnv,
  database: AuthorityDatabase = runtimeDatabase(env),
): PostgresRuntimeRepository {
  return new PostgresRuntimeRepository(database, env.RELAY_POSTGRES_SHARD_ID?.trim() || undefined);
}

/** Moves an Agent Launch along as its daemon reports admission, spawn or failure. */
export function updateAgentLaunch(env: PostgresAuthorityFleetEnv, input: Omit<
  Parameters<PostgresRuntimeRepository["updateAgentLaunch"]>[0], "requestId" | "at"> & { at?: unknown }) {
  return runtimeRepository(env).updateAgentLaunch({ ...input, requestId: crypto.randomUUID(),
    at: boundedOccurrenceAt(input.at) });
}

/** A launch decision's databases: the Space shards and the registration directory. */
export function runtimePlacement<E extends RuntimeEnv>(env: E) {
  return { env, database: runtimeDatabase(env), directory: runtimeDirectory(env) };
}

/** Jev for one decision about a message, recording its evidence; none while Jev is unconfigured. */
export function jevEvaluator(env: RuntimeEnv, context: {
  actorUserId: string; channelId: string; sourceMessageId: string; invocationId: string;
}): RoutingEvaluator | undefined {
  const apiKey = env.JEV_AI_GATEWAY_API_KEY?.trim();
  if (!apiKey) return undefined;
  return summonDecisionEvaluator(env, { evaluate: createJevClient({ apiKey, timeoutMs: 5000 }).evaluate, ...context });
}

/**
 * An Instance's display state — model, effort, usage — which is not a
 * lifecycle transition: it writes no command replay and publishes no route.
 * Usage it reports also updates its registration's quota reading.
 */
export async function recordInstancePresentation(env: RuntimeEnv, input: {
  commandId: string; actorUserId: string; spaceId: string; instanceId: string;
  presentation: Record<string, unknown> | null; status?: string; at: string;
}) {
  const result = await runtimeRepository(env).recordInstancePresentation({
    actorUserId: input.actorUserId, requestId: input.commandId, spaceId: input.spaceId,
    instanceId: input.instanceId, presentation: input.presentation,
    ...(input.status ? { status: input.status } : {}), at: input.at,
  });
  if (result.registration) {
    await observeRegistrationQuota(runtimeDirectory(env), result.registration, input.presentation?.usage, input.commandId);
  }
  return { instanceId: result.instanceId, recorded: result.recorded };
}

/** Asks the daemons behind a Channel's Space's registrations to read their quota again. */
export async function refreshChannelRoutingQuota(env: Env, input: { channelId: string; actorUserId: string }) {
  const database = runtimeDatabase(env);
  const directory = createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-quota-probe", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }).directoryDatabase;
  return refreshAgentRoutingQuota({ env, directory, runtime: runtimeRepository(env, database), ...input,
    registrationTargets: registrationQuotaProbeTargetReader(database, directory) });
}
