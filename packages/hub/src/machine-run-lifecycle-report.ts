import { PostgresMachineLifecycleRepository, RuntimeControlError, type AuthorityDatabase } from "@xmatrix/db";

import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { isRecoverableLaunchFailure } from "./live-run-admission";
import { publishMachineRunFailureNotice, publishMachineStopResultNotice } from "./machine-run-failure-notice";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import {
  POSTGRES_AUTHORITY_TIMEOUTS,
  postgresOptionalRequestText,
  postgresRequestObject,
  postgresRequestText,
} from "./postgres-authority-http";
import { machineRunStartupFailureDetail, machineSpawnRepoPoolMetadata } from "./machine-run-failure";
import type { Env } from "./types";

function invalid(field: string): RuntimeControlError {
  return new RuntimeControlError("invalid_runtime_request", 400, `${field} is invalid`);
}

function object(value: unknown, field = "request body"): Record<string, unknown> {
  return postgresRequestObject(value, () => invalid(field));
}

function text(value: unknown, field: string, maximumBytes = 300): string {
  return postgresRequestText(value, () => invalid(field), maximumBytes);
}

function optionalHostname(value: unknown): string {
  return postgresOptionalRequestText(value, () => invalid("hostname"), 160);
}

function optionalMachineName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : undefined;
}

/**
 * Records one Run lifecycle event its daemon reported — a spawn, stop, reply
 * recovery or cleanup result — on the Run's Space shard. A recoverable spawn
 * failure re-queues its Launch and wakes the Channel coordinator to offer it
 * again; an unrecoverable start failure and a stop result each leave a notice
 * in the Run's Channel.
 */
export async function machineRunLifecycleReport(
  env: Env,
  input: Record<string, unknown>,
  dependencies: { database?: AuthorityDatabase } = {},
): Promise<Record<string, unknown>> {
  const database = dependencies.database ?? createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-runtime", ...POSTGRES_AUTHORITY_TIMEOUTS });
  const payload = object(input.payload, "payload");
  const value = await new PostgresMachineLifecycleRepository(database).apply({
    commandId: text(input.commandId, "commandId", 200),
    ownerUserId: text(input.ownerUserId, "ownerUserId", 200),
    machineId: text(input.machineId, "machineId", 160),
    hostId: optionalHostname(input.hostId),
    connectionEpoch: input.connectionEpoch === undefined ? undefined : Number(input.connectionEpoch),
    channelId: text(input.channelId, "channelId", 300),
    principal: object(input.principal, "principal"),
    eventType: text(input.eventType, "eventType", 80),
    payload,
    recoverableLaunchFailure: isRecoverableLaunchFailure(payload.error),
    repoPool: input.eventType === "machine_spawn_result" ? machineSpawnRepoPoolMetadata(payload) : undefined,
    preserveInstanceForReborn: input.runLifecycleStopPurpose === "reborn-predecessor",
  });
  if (input.eventType === "machine_spawn_result" && payload.ok !== true &&
      isRecoverableLaunchFailure(payload.error)) {
    await wakeAgentLaunchCoordinator(env, text(input.channelId, "channelId", 300));
  }
  const ownerEmail = (ownerUserId: unknown) => typeof input.ownerEmail === "string"
    ? input.ownerEmail : `${String(ownerUserId)}@unknown.invalid`;
  if ("startupFailureNoticeContext" in value) {
    const failure = machineRunStartupFailureDetail(String(input.eventType), payload);
    if (failure && !isRecoverableLaunchFailure(failure.detail)) {
      const context = object(value.startupFailureNoticeContext, "startupFailureNoticeContext");
      await publishMachineRunFailureNotice(env, {
        runId: text(context.runId, "runId"), channelId: text(context.channelId, "channelId"),
        ownerUserId: text(context.ownerUserId, "ownerUserId"), ownerEmail: ownerEmail(context.ownerUserId),
        agentName: text(context.agentName, "agentName"), machineId: text(context.machineId, "machineId"),
        hostId: optionalHostname(context.hostId), machineName: optionalMachineName(context.machineName), ...failure,
      });
    }
  }
  if ("stopResultNoticeContext" in value) {
    const context = object(value.stopResultNoticeContext, "stopResultNoticeContext");
    // The lifecycle report is already durable; a notice failure must not
    // make the daemon retry it. Its stable ids make a replay safe.
    await publishMachineStopResultNotice(env, {
      runId: text(context.runId, "runId"), controlKey: text(context.controlKey, "controlKey"),
      channelId: text(context.channelId, "channelId"), agentName: text(context.agentName, "agentName"),
      ok: context.ok === true, ...(typeof context.detail === "string" ? { detail: context.detail } : {}),
      ...(context.startupFailed === true ? { startupFailed: true } : {}),
      ownerUserId: text(context.ownerUserId, "ownerUserId"), ownerEmail: ownerEmail(context.ownerUserId),
      machineId: text(context.machineId, "machineId"), hostId: optionalHostname(context.hostId),
      machineName: optionalMachineName(context.machineName),
    }).catch(error => console.error("Machine Daemon stop result notice append failed", {
      runId: context.runId, channelId: context.channelId, error: error instanceof Error ? error.message : String(error) }));
    delete value.stopResultNoticeContext;
  }
  return value;
}
