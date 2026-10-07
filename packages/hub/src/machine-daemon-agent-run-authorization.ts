import { defaultAgentRunPermissions } from "@xmatrix/protocol";
import type { Env } from "./types";
import type { MachineDaemonPrincipal } from "./connections/machine-daemon/auth";
import { signAgentRunToken } from "./auth";
import { agentRunTokenContextMismatch } from "./live-run-admission";
import { authorizeRegistrationExecution, type ConfirmedMachineLease } from "./registration-execution-admission";
import { controlErrorResponse } from "./postgres-authority-http";
import { runtimeRepository } from "./runtime";

export interface MachineDaemonAgentRunAuthorizationInput {
  runId?: string;
  executionKey?: string;
  agentId?: string;
  channelId?: string;
  spaceId?: string;
  instanceId?: string;
  registration?: unknown;
}

export type MachineDaemonAgentRunAuthorization = {
  token: string;
  expiresIn: number;
  principal: Record<string, unknown>;
};

export async function authorizeMachineDaemonAgentRun(
  env: Env,
  principal: MachineDaemonPrincipal,
  body: MachineDaemonAgentRunAuthorizationInput,
  confirmedLease?: ConfirmedMachineLease,
): Promise<MachineDaemonAgentRunAuthorization | Response> {
  const requestedSpaceId = typeof body.spaceId === "string" ? body.spaceId.trim() : "";
  const requestedChannelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!requestedSpaceId || !requestedChannelId) {
    return Response.json({ error: "spaceId and channelId are required for an Agent Run token" }, {
      status: 400,
    });
  }
  const runResult = await runtimeRepository(env).getRun({ requestId: crypto.randomUUID(), runId: String(body.runId ?? ""),
    actorUserId: principal.ownerUserId, requireExecutionAccess: true }).catch(controlErrorResponse);
  if (runResult instanceof Response) return runResult;
  const run = runResult.run as Record<string, unknown>;
  const runMetadata = run.metadata && typeof run.metadata === "object" && !Array.isArray(run.metadata)
    ? run.metadata as Record<string, unknown> : {};
  const metadata = run.metadata as Record<string, unknown> | undefined;
  const tokenContextMismatch = agentRunTokenContextMismatch({ run, body });
  if (tokenContextMismatch) return Response.json({ error: tokenContextMismatch }, { status: 403 });
  // A background session has no Channel Instance; its session id stands in for one.
  if (body.instanceId && body.instanceId !== (run.instanceId ?? runMetadata.runtimeSessionId)) {
    return Response.json({ error: "Agent run Instance does not match the Launch" }, { status: 403 });
  }

  // The retired management delegate; a Run started before it was retired never runs again.
  if (metadata?.routedAs === "management_assistant_mention") {
    return Response.json({ error: "The xMatrix management agent is retired" }, { status: 403 });
  }
  if (metadata?.routedAs === "management_channel_about" &&
      !(typeof metadata.managementSpaceId === "string" && metadata.managementSpaceId.trim())) {
    return Response.json({ error: "Channel About session has no Space" }, { status: 403 });
  }
  const targetMachineId = typeof metadata?.machineId === "string" ? metadata.machineId.trim() : "";
  const targetHostId = typeof metadata?.hostId === "string" ? metadata.hostId.trim() : "";
  const channelAboutSession = metadata?.routedAs === "management_channel_about";
  const runtimeSessionId = channelAboutSession && typeof metadata?.runtimeSessionId === "string"
    ? metadata.runtimeSessionId.trim() : "";
  const targetInstanceId = typeof run.instanceId === "string" && run.instanceId.trim()
    ? run.instanceId.trim() : runtimeSessionId;
  if (!targetMachineId || targetMachineId !== principal.machineId) {
    return Response.json({ error: "Agent run target does not match this machine daemon" }, {
      status: 403,
    });
  }
  const registrationFailure = await authorizeRegistrationExecution({ env, principal,
    runId: String(run.runId), spaceId: requestedSpaceId,
    phase: registrationExecutionPhase(run.status, confirmedLease),
    admission: runResult.registrationAdmission, confirmedLease,
    claimedBinding: body.registration === null ? undefined : body.registration, instanceId: targetInstanceId,
    workspaceCwd: (run.workspace as { canonicalCwd?: string } | undefined)?.canonicalCwd,
    workspaceRepository: typeof runMetadata.remoteRepo === "string" ? runMetadata.remoteRepo : undefined });
  if (registrationFailure) return registrationFailure;
  const context = {
    // A Run acts as its Instance; a background session is its session.
    agentId: targetInstanceId,
    agentName: String(runMetadata.agentName || "Agent"),
    runId: String(run.runId),
    executionKey: String(body.executionKey),
    ...(targetInstanceId ? { instanceId: targetInstanceId } : {}),
    spaceId: requestedSpaceId,
    channelId: String(run.channelId),
    machineId: targetMachineId,
    hostId: targetHostId,
    runKind: channelAboutSession ? "channel-about-session" as const : "channel-instance" as const,
    channelWriteAllowed: !channelAboutSession,
    permissions: channelAboutSession ? [] : defaultAgentRunPermissions(),
    ...(typeof metadata?.managementSpaceId === "string" && metadata.managementSpaceId.trim()
      ? { managementSpaceId: metadata.managementSpaceId.trim() } : {}),
  };
  const token = await signAgentRunToken(
    env,
    { id: principal.ownerUserId, email: principal.ownerEmail },
    context,
  );
  return { token, expiresIn: 600, principal: context };
}

/** Only the lease-renewing command admission performs a starting Run's first
 * registration admission. Every other token request for the Run — a daemon
 * minting its wrapper's token while the Run is still starting included — is a
 * continuation, which still requires that admission to have happened. */
export function registrationExecutionPhase(
  runStatus: unknown,
  confirmedLease: ConfirmedMachineLease | undefined,
): "admission" | "continuation" {
  return confirmedLease && runStatus === "starting" ? "admission" : "continuation";
}
