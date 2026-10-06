import { ControlError, PostgresAutomationRepository, PostgresSchedulerControlRepository } from "@xmatrix/db";

import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { createPostgresAuthorityFleet, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import type { Env } from "./types";

function automationDatabase(env: PostgresAuthorityFleetEnv) {
  return createPostgresAuthorityFleet(env, { applicationName: "xmatrix-hub-automation", ...POSTGRES_AUTHORITY_TIMEOUTS })
    .database;
}

/** Automations live with their Channel on its Space shard, located by id. */
export function automationRepository(env: PostgresAuthorityFleetEnv): PostgresAutomationRepository {
  return new PostgresAutomationRepository(automationDatabase(env));
}

/** Intents and the Space's action claims, on the same shards. */
export function schedulerRepository(env: PostgresAuthorityFleetEnv): PostgresSchedulerControlRepository {
  return new PostgresSchedulerControlRepository(automationDatabase(env));
}

/** One Automation as its reader may see it, with what they may do to it. */
export function getAutomation(env: PostgresAuthorityFleetEnv, input: Record<string, unknown>) {
  return automationRepository(env).get({ ...input, requestId: crypto.randomUUID() });
}

/** Every Automation of a Channel or Space its reader may see, following the cursor. */
export async function listAutomations(env: PostgresAuthorityFleetEnv, input: Record<string, unknown>) {
  const repository = automationRepository(env);
  const automations: unknown[] = [];
  let executionEnabled = true;
  let cursor: string | undefined;
  do {
    const page = await repository.list({ ...input, requestId: crypto.randomUUID(), limit: 200,
      ...(cursor ? { cursor } : {}) });
    automations.push(...(Array.isArray(page.tasks) ? page.tasks : []));
    executionEnabled &&= page.executionEnabled === true;
    cursor = typeof page.cursor === "string" && page.cursor ? page.cursor : undefined;
  } while (cursor);
  return { automations, executionEnabled };
}

/**
 * Puts, removes or cancels an Automation's execution. The Automation's Channel
 * times it, so the change is handed to that Channel's coordinator before it is
 * answered; a failed handoff fails the request and its idempotent retry hands
 * it off again.
 */
export async function commitAutomation(env: Env, input: Record<string, unknown>) {
  const committed = await automationRepository(env).mutate(input);
  const channelId = typeof committed.channelId === "string" ? committed.channelId : "";
  if (channelId) {
    try {
      await wakeAgentLaunchCoordinator(env, channelId);
    } catch {
      throw new ControlError("scheduler_coordination_unavailable", 503,
        "Automation committed but its Channel coordinator did not accept the change", true);
    }
  }
  return committed;
}
