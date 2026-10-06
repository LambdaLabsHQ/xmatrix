import { Hono } from "hono";
import { HUB_ROUTES , utf8ByteLength } from "@xmatrix/protocol";
import type { Env } from "./types";
import {
  productCommandId,
  machineDaemonControl,
  machineDaemonLifecycleReport,
  requireMachineDaemonAuth,
  requestErrorResponse,
} from "./index-shared";
import { authorizeMachineDaemonAgentRun } from "./machine-daemon-agent-run-authorization";
import { recordAgentLaunchStage } from "./postgres-observability";
import { controlErrorResponse } from "./postgres-authority-http";
import { workspaceRepository } from "./postgres-workspace-authority";
import { updateAgentLaunch } from "./runtime";
import type { MachineDaemonPrincipal } from "./connections/machine-daemon/auth";
import { isRecoverableLaunchFailure } from "./live-run-admission";
export { machineSpawnRegistryEvidenceMatches } from "./machine-daemon-result-causality";

function requiredText(value: unknown, maximum = 4_000): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text && utf8ByteLength(text) <= maximum ? text : undefined;
}

export async function applyMachineDaemonSpawnLaunchResult(input: {
  env: Env;
  principal: Readonly<{ ownerUserId: string }>;
  body: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const { env, principal, body } = input;
  if (body.type !== "machine_spawn_result") return;
  const launchId = requiredText(body.launchId, 200);
  const channelId = requiredText(body.channelId, 200);
  if (!launchId || !channelId) return;
  const started = performance.now();
  let outcome: "ok" | "error" = "error";
  try {
    await updateAgentLaunch(env, {
      launchId,
      channelId,
      actorUserId: principal.ownerUserId,
      state: body.ok === false ? "failed" : "spawned",
      at: body.ok === false ? new Date().toISOString() : body.spawnedAt,
      ...(body.ok === false ? {
        errorStage: "daemon_spawn",
        errorCode: "daemon_spawn_failed",
        errorMessage: requiredText(body.error, 2_000),
        retryable: isRecoverableLaunchFailure(body.error),
      } : {}),
    });
    outcome = "ok";
  } finally {
    recordAgentLaunchStage({ env, stage: "daemon_spawn", outcome, durationMs: performance.now() - started });
  }
}

/**
 * Commit the Channel-scoped Run lifecycle replica for an HTTP daemon report.
 * The reverse socket already does this for every report it carries; HTTP
 * reports must reach the same Channel authority or the Run keeps neither its
 * spawn status nor the registry causality that fences stale snapshots.
 */
export async function dispatchMachineDaemonRunLifecycleReplica(input: {
  env: Env;
  request: Request;
  principal: MachineDaemonPrincipal;
  requestId: string;
  eventType: string;
  channelId: string;
  connectionEpoch: number;
  body: Readonly<Record<string, unknown>>;
  stopPurpose?: unknown;
}): Promise<void> {
  const { env, principal } = input;
  await machineDaemonLifecycleReport(env, principal, {
    commandId: productCommandId(
      input.request, "machine-daemon-control", `http-run-lifecycle:${input.requestId}`,
    ),
    action: "report",
    eventType: input.eventType,
    connectionEpoch: input.connectionEpoch,
    payload: input.body,
    channelId: input.channelId,
    ...(input.stopPurpose === "reborn-predecessor"
      ? { runLifecycleStopPurpose: "reborn-predecessor" }
      : {}),
  });
}

async function terminalAdmissionResponse(
  response: Response,
  leaseUntil: unknown,
): Promise<Response> {
  if (response.status < 400 || response.status >= 500 ||
      response.status === 408 || response.status === 429) return response;
  const failure: Record<string, unknown> = await response.clone()
    .json<Record<string, unknown>>().catch(() => ({}));
  const code = requiredText(failure.code, 200);
  return Response.json({
    ok: false,
    terminal: true,
    leaseUntil,
    error: requiredText(failure.error, 2_000) || "Machine spawn admission was rejected",
    ...(code ? { code } : {}),
  }, { status: 200, headers: { "cache-control": "private, no-store" } });
}

/** New-CLI spawn preflight: lease admission, exact workspace check, and initial Run token. */
export function registerIndexRoutesMachineDaemonAdmission(
  app: Hono<{ Bindings: Env }>,
): void {
  app.post(HUB_ROUTES.daemon_command_admit_authorize, async (c) => {
    const started = performance.now();
    try {
      const principal = await requireMachineDaemonAuth(c.req.raw, c.env);
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const requestId = requiredText(body.requestId, 200);
      const launchId = requiredText(body.launchId, 200);
      const spaceId = requiredText(body.spaceId, 300);
      const channelId = requiredText(body.channelId, 200);
      const runId = requiredText(body.runId, 200);
      const instanceId = requiredText(body.instanceId, 200);
      const executionKey = requiredText(body.executionKey, 300);
      const agentId = requiredText(body.agentId, 200);
      const workspace = body.workspace && typeof body.workspace === "object" &&
          !Array.isArray(body.workspace)
        ? body.workspace as Record<string, unknown> : undefined;
      const canonicalCwd = requiredText(workspace?.canonicalCwd);
      // A reborn successor has no Launch row: its authority is the lease, the
      // Run and its registration binding. Only such a registered spawn may
      // omit the Launch; the admission never depends on the Launch existing.
      const registeredWithoutLaunch = !launchId && body.registration !== undefined &&
        body.registration !== null;
      if (!requestId || (!launchId && !registeredWithoutLaunch) || !spaceId || !channelId || !runId ||
          !instanceId || !executionKey || !agentId || !workspace || !canonicalCwd) {
        return c.json({ error: "Complete immutable spawn authority is required" }, 400);
      }
      const relayLease = body.relayLease;
      const connectionEpoch = Number(
        (relayLease as Record<string, unknown> | undefined)?.daemonEpoch,
      );
      const renewed = await machineDaemonControl(c.env, principal, {
        commandId: `daemon-admit-authorize:${requestId}:${
          Number((relayLease as Record<string, unknown> | undefined)?.leaseGeneration) || 0}`,
        action: "renew",
        controlId: requestId,
        leaseMs: 60_000,
        payload: {},
        expected: { launchId, spaceId, runId, instanceId, executionKey, channelId, agentId,
          workspaceCanonicalCwd: canonicalCwd },
        relayLease,
        connectionEpoch,
      });

      const managedKey = requiredText(workspace.managedKey, 300);
      const managementSpaceId = requiredText(body.managementSpaceId, 200);
      const remoteRepo = requiredText(body.remoteRepo, 500);
      // Only a directory its owner registered on this Machine is admitted.
      const exactWorkspacePromise: Promise<Response | null> = !managementSpaceId && !(remoteRepo && managedKey)
        ? workspaceRepository(c.env).getExact({
            requestId: `daemon-workspace-authorize:${requestId}`,
            ownerUserId: principal.ownerUserId,
            machineId: principal.machineId,
            canonicalCwd,
          }).then(() => null, controlErrorResponse)
        : Promise.resolve(null);
      const [unregistered, authorized] = await Promise.all([
        exactWorkspacePromise,
        authorizeMachineDaemonAgentRun(c.env, principal, {
          runId, instanceId, executionKey, agentId, spaceId, channelId,
          registration: body.registration,
        }, {
          daemonId: requiredText((renewed.daemon as Record<string, unknown> | undefined)?.id, 300),
          connectionEpoch: Number(renewed.connectionEpoch),
        }),
      ]);
      if (unregistered) return terminalAdmissionResponse(unregistered, renewed.leaseUntil);
      if (authorized instanceof Response) {
        return terminalAdmissionResponse(authorized, renewed.leaseUntil);
      }
      if (launchId) {
        const launchRefusal = await updateAgentLaunch(c.env, {
          launchId, channelId, actorUserId: principal.ownerUserId, state: "admitted", at: body.admittedAt,
        }).then(() => null, controlErrorResponse);
        if (launchRefusal) return terminalAdmissionResponse(launchRefusal, renewed.leaseUntil);
      }
      recordAgentLaunchStage({ env: c.env, stage: "daemon_admit", outcome: "ok",
        durationMs: performance.now() - started });
      return c.json({
        ok: true,
        leaseUntil: renewed.leaseUntil,
        token: authorized.token,
        expiresIn: authorized.expiresIn,
        principal: authorized.principal,
      });
    } catch (error) {
      recordAgentLaunchStage({ env: c.env, stage: "daemon_admit", outcome: "error",
        durationMs: performance.now() - started });
      return requestErrorResponse(c, error);
    }
  });
}
