import { plainRecord, repoSummonReference } from "@xmatrix/protocol";
import type { LiveAgentStatus } from "@xmatrix/protocol";
import { isLiveAgentStatus } from "@xmatrix/protocol";
import type { AgentInstanceRuntimeSession } from "./agent-instance-port";
import {
  agentMessagePresentation,
  sanitizeAgentInstancePresentation,
  type AgentInstancePresentation,
} from "./agent-instance-presentation";
import { loadRuntimePresenceSnapshotEntries } from "./runtime-presence-snapshot";

export const RELAY_RUNTIME_AGENT_PRESENCE_PATH = "/internal/agent-presence";

const MAX_LIVE_AGENT_SESSIONS = 512;

export interface LiveAgentSessionSnapshot {
  ownerUserId: string;
  agentId: string;
  agentName: string;
  runId: string;
  instanceId: string;
  channelId: string;
  channelInstanceId?: string;
  machineId: string;
  hostId: string;
  cwd?: string;
  repository?: string;
  /** What the Instance last reported over its own socket. */
  status: LiveAgentStatus;
  connectedAt: string;
  lastSeenAt: string;
  presentation?: AgentInstancePresentation;
}

/** The route of the Machine Daemon that hosts one live Instance's Run. */
export interface LiveAgentMachineRoute {
  ownerUserId: string;
  machineId: string;
  hostId: string;
}

export function liveAgentMachineRoute(
  session: Readonly<Pick<AgentInstanceRuntimeSession, "principal" | "run">>,
): LiveAgentMachineRoute {
  return {
    ownerUserId: session.principal.ownerUserId,
    machineId: session.run.machineId,
    hostId: session.run.hostId,
  };
}

export interface LiveAgentPresentationBinding {
  agentId: string;
  runId: string;
  instanceId: string;
  channelId: string;
}

export function liveAgentSessionSnapshots(
  sessions: Iterable<Readonly<AgentInstanceRuntimeSession>>,
  /* Every Agent message send reads exactly one binding. Rejecting the other
     sessions here — before each is sanitized into a snapshot — is what keeps
     that read proportional to the answer instead of to everything live. */
  binding?: LiveAgentPresentationBinding,
): LiveAgentSessionSnapshot[] {
  const snapshots: LiveAgentSessionSnapshot[] = [];
  for (const session of sessions) {
    if (snapshots.length >= MAX_LIVE_AGENT_SESSIONS) break;
    if (binding && !sessionMatchesBinding(session, binding)) continue;
    snapshots.push({
      ownerUserId: session.principal.ownerUserId,
      agentId: session.principal.agentId,
      agentName: session.principal.agentName,
      runId: session.principal.runId,
      instanceId: session.run.instanceId,
      channelId: session.run.channelId,
      ...(session.run.channelInstanceId
        ? { channelInstanceId: session.run.channelInstanceId }
        : {}),
      machineId: session.run.machineId,
      hostId: session.run.hostId,
      ...(session.run.cwd ? { cwd: session.run.cwd } : {}),
      ...(session.run.repository ? { repository: session.run.repository } : {}),
      status: session.run.instanceStatus,
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
      ...(session.presentation
        ? { presentation: sanitizeAgentInstancePresentation(session.presentation) }
        : {}),
    });
  }
  return snapshots;
}

function sessionMatchesBinding(
  session: Readonly<AgentInstanceRuntimeSession>,
  binding: LiveAgentPresentationBinding,
): boolean {
  return session.principal.agentId === binding.agentId &&
    session.principal.runId === binding.runId &&
    session.run.instanceId === binding.instanceId &&
    session.run.channelId === binding.channelId;
}

export async function loadLiveAgentPresenceFromRuntime(
  runtime: { fetch(request: Request): Promise<Response> },
  requestUrl: string,
  binding?: LiveAgentPresentationBinding,
): Promise<LiveAgentSessionSnapshot[]> {
  const url = new URL(RELAY_RUNTIME_AGENT_PRESENCE_PATH, requestUrl);
  if (binding) {
    url.searchParams.set("agentId", binding.agentId);
    url.searchParams.set("runId", binding.runId);
    url.searchParams.set("instanceId", binding.instanceId);
    url.searchParams.set("channelId", binding.channelId);
  }
  return (await loadRuntimePresenceSnapshotEntries(runtime, url))
    .slice(0, MAX_LIVE_AGENT_SESSIONS)
    .flatMap(parseLiveAgentSessionSnapshot);
}

export function agentMessagePresentationForLiveBinding(
  sessions: readonly LiveAgentSessionSnapshot[],
  binding: LiveAgentPresentationBinding,
): Record<string, unknown> | undefined {
  const session = liveAgentSessionForBinding(sessions, binding);
  if (!session) return undefined;
  return agentMessagePresentationForLiveSnapshot(session);
}

export function agentMessagePresentationForLiveSnapshot(
  session: Readonly<LiveAgentSessionSnapshot>,
): Record<string, unknown> {
  const instanceLabel = session.channelInstanceId
    ? `${session.agentName}:${session.channelInstanceId}`
    : session.agentName;
  return {
    identityId: session.agentId,
    kind: "agent",
    agentId: session.agentId,
    label: instanceLabel,
    name: session.agentName,
    agentName: session.agentName,
    userId: session.ownerUserId,
    instanceId: session.instanceId,
    ...(session.channelInstanceId
      ? {
          channelInstanceId: session.channelInstanceId,
          instanceLabel,
        }
      : {}),
    ...(session.presentation?.workspace
      ? { workspace: session.presentation.workspace }
      : {}),
    ...(session.presentation?.workspaceName
      ? { workspaceName: session.presentation.workspaceName }
      : {}),
    ...agentMessagePresentation(session.presentation),
  };
}

function liveAgentSessionForBinding(
  sessions: readonly LiveAgentSessionSnapshot[],
  binding: LiveAgentPresentationBinding,
): LiveAgentSessionSnapshot | undefined {
  const matches = sessions.filter((session) =>
    session.agentId === binding.agentId &&
    session.runId === binding.runId &&
    session.instanceId === binding.instanceId &&
    session.channelId === binding.channelId
  );
  if (matches.length !== 1) return undefined;
  return matches[0];
}

function parseLiveAgentSessionSnapshot(value: unknown): LiveAgentSessionSnapshot[] {
  if (!record(value)) return [];
  const ownerUserId = boundedText(value.ownerUserId, 200);
  const agentId = boundedText(value.agentId, 200);
  const agentName = boundedText(value.agentName, 128);
  const runId = boundedText(value.runId, 200);
  const instanceId = boundedText(value.instanceId, 200);
  const channelId = boundedText(value.channelId, 180);
  const machineId = boundedText(value.machineId, 200);
  const hostId = boundedText(value.hostname ?? value.hostId, 160) || "";
  const connectedAt = boundedDate(value.connectedAt);
  const lastSeenAt = boundedDate(value.lastSeenAt);
  const status = isLiveAgentStatus(value.status)
    ? value.status
    : undefined;
  if (
    !ownerUserId ||
    !agentId ||
    !agentName ||
    !runId ||
    !instanceId ||
    !channelId ||
    !machineId ||
    !connectedAt ||
    !lastSeenAt ||
    !status
  ) {
    return [];
  }
  const channelInstanceId = boundedText(value.channelInstanceId, 32);
  const cwd = boundedText(value.cwd, 2_048);
  const repositoryText = boundedText(value.repository, 2_048);
  const repository = repositoryText ? repoSummonReference(repositoryText) : undefined;
  const presentation = value.presentation === undefined
    ? undefined
    : sanitizeAgentInstancePresentation(value.presentation);
  if (value.presentation !== undefined && !presentation) return [];
  return [{
    ownerUserId,
    agentId,
    agentName,
    runId,
    instanceId,
    channelId,
    ...(channelInstanceId ? { channelInstanceId } : {}),
    machineId,
    hostId,
    ...(cwd ? { cwd } : {}),
    ...(repository ? { repository } : {}),
    status,
    connectedAt,
    lastSeenAt,
    ...(presentation ? { presentation } : {}),
  }];
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean && clean.length <= maxLength ? clean : undefined;
}

function boundedDate(value: unknown): string | undefined {
  const text = boundedText(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return plainRecord(value) !== undefined;
}
