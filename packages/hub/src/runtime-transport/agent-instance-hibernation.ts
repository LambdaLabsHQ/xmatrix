import type { LiveAgentStatus } from "@xmatrix/protocol";
import { isLiveAgentStatus } from "@xmatrix/protocol";
import type { AgentInstanceRuntimeSession } from "./agent-instance-port";
import {
  hibernationBoundedJson,
  hibernationClientVersions,
  hibernationBoundedString,
  hibernationHasExactKeys,
  hibernationHasOnlyKeys,
  hibernationRecord,
  hibernationValidDate,
  hibernationValidExpiry,
  nextRuntimeHibernationExpiry,
} from "./hibernation-bounds";
import {
  compactAgentInstancePresentationForHibernation,
  sanitizeAgentInstancePresentation,
} from "./agent-instance-presentation";

export interface AgentInstanceHibernationAttachment {
  version: 1;
  domain: "agent_instance";
  expiresAt: string;
  session: AgentInstanceRuntimeSession;
}

export function serializeAgentInstanceHibernationAttachment(
  session: Readonly<AgentInstanceRuntimeSession>,
): AgentInstanceHibernationAttachment {
  const expiresAt = nextRuntimeHibernationExpiry();
  const parseSession = (candidate: Readonly<AgentInstanceRuntimeSession>) =>
    parseAgentInstanceHibernationAttachment({
      version: 1,
      domain: "agent_instance",
      expiresAt,
      session: candidate,
    });
  const full = parseSession(session);
  if (full) return full;
  const compactPresentation = compactAgentInstancePresentationForHibernation(session.presentation);
  const compact = parseSession({
      principal: session.principal,
      run: session.run,
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
      clientVersion: session.clientVersion,
      clientProtocolVersion: session.clientProtocolVersion,
      ...(compactPresentation ? { presentation: compactPresentation } : {}),
  });
  const parsed = compact || parseSession({
      principal: session.principal,
      run: session.run,
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
      clientVersion: session.clientVersion,
      clientProtocolVersion: session.clientProtocolVersion,
  });
  if (!parsed) throw new Error("Agent Instance session cannot be serialized as a bounded hibernation attachment");
  return parsed;
}

export function parseAgentInstanceHibernationAttachment(value: unknown): AgentInstanceHibernationAttachment | undefined {
  if (!hibernationRecord(value) || !hibernationHasExactKeys(value, ["version", "domain", "expiresAt", "session"]) ||
      value.version !== 1 || value.domain !== "agent_instance" || !hibernationValidExpiry(value.expiresAt) || !hibernationBoundedJson(value)) return undefined;
  const session = value.session;
  if (!hibernationRecord(session) ||
      !hibernationHasOnlyKeys(session, [
        "principal", "run", "connectedAt", "lastSeenAt", "clientVersion",
        "clientProtocolVersion", "presentation",
      ]) ||
      !["principal", "run", "connectedAt", "lastSeenAt"].every((key) =>
        Object.prototype.hasOwnProperty.call(session, key)) ||
      !hibernationValidDate(session.connectedAt) || !hibernationValidDate(session.lastSeenAt)) return undefined;
  const hasValidClientVersion = session.clientVersion === undefined ||
    hibernationBoundedString(session.clientVersion, 64);
  const hasValidClientProtocol = session.clientProtocolVersion === undefined ||
    (Number.isSafeInteger(session.clientProtocolVersion) && (session.clientProtocolVersion as number) > 0);
  if (!hasValidClientVersion || !hasValidClientProtocol) {
    return undefined;
  }
  const principal = session.principal;
  const run = session.run;
  const principalKeys = ["ownerUserId", "agentId", "agentName", "spaceId", "runId", "executionKey", "channelId", "machineId"] as const;
  const optionalPrincipalKeys = ["hostId", "runKind", "channelWriteAllowed"] as const;
  const requiredRunKeys = ["runId", "agentId", "instanceId", "executionKey", "channelId", "machineId", "status", "instanceStatus"] as const;
  const optionalRunKeys = ["hostId", "kind", "channelDeliveryEnabled", "channelInstanceId", "cwd", "connectionVersion"] as const;
  if (!hibernationRecord(principal) ||
      !hibernationHasOnlyKeys(principal, [...principalKeys, ...optionalPrincipalKeys]) ||
      !principalKeys.every((key) => Object.prototype.hasOwnProperty.call(principal, key)) ||
      !principalKeys.every((key) => hibernationBoundedString(principal[key])) ||
      !hibernationRecord(run) ||
      !hibernationHasOnlyKeys(run, [...requiredRunKeys, ...optionalRunKeys]) ||
      !requiredRunKeys.slice(0, 6).every((key) => hibernationBoundedString(run[key])) ||
      ![principal, run].every(item => item.hostId === undefined || item.hostId === "" || hibernationBoundedString(item.hostId, 160)) ||
      !(run.channelDeliveryEnabled === undefined || typeof run.channelDeliveryEnabled === "boolean") ||
      !(run.channelInstanceId === undefined || hibernationBoundedString(run.channelInstanceId)) ||
      !(run.cwd === undefined || hibernationBoundedString(run.cwd, 2_048)) ||
      !(run.connectionVersion === undefined ||
        Number.isSafeInteger(run.connectionVersion) && (run.connectionVersion as number) > 0) ||
      !(run.kind === undefined || run.kind === "channel-instance" || run.kind === "channel-about-session") ||
      !(principal.runKind === undefined || principal.runKind === "channel-instance" ||
        principal.runKind === "channel-about-session") ||
      !(principal.channelWriteAllowed === undefined || typeof principal.channelWriteAllowed === "boolean") ||
      !["starting", "running"].includes(String(run.status)) ||
      !isLiveAgentStatus(run.instanceStatus) ||
      run.runId !== principal.runId || run.agentId !== principal.agentId ||
      run.executionKey !== principal.executionKey || run.channelId !== principal.channelId ||
      run.machineId !== principal.machineId) return undefined;
  const runKind = run.kind === "channel-about-session"
    ? "channel-about-session"
    : "channel-instance";
  const principalRunKind = principal.runKind === "channel-about-session"
    ? "channel-about-session"
    : "channel-instance";
  const channelWriteAllowed = principal.channelWriteAllowed !== false;
  if (runKind !== principalRunKind ||
      (runKind === "channel-about-session" && channelWriteAllowed)) return undefined;
  const runOut: AgentInstanceRuntimeSession["run"] = {
    kind: runKind,
    runId: String(run.runId),
    agentId: String(run.agentId),
    instanceId: String(run.instanceId),
    executionKey: String(run.executionKey),
    channelId: String(run.channelId),
    machineId: String(run.machineId),
    hostId: typeof run.hostId === "string" ? run.hostId : "",
    status: run.status as "starting" | "running",
    instanceStatus: run.instanceStatus as LiveAgentStatus,
    ...(typeof run.connectionVersion === "number" ? { connectionVersion: run.connectionVersion } : {}),
    ...(typeof run.channelDeliveryEnabled === "boolean"
      ? { channelDeliveryEnabled: run.channelDeliveryEnabled }
      : {}),
    ...(typeof run.channelInstanceId === "string" ? { channelInstanceId: run.channelInstanceId } : {}),
    ...(typeof run.cwd === "string" ? { cwd: run.cwd } : {}),
  };
  const presentation = session.presentation === undefined
    ? undefined
    : sanitizeAgentInstancePresentation(session.presentation);
  if (session.presentation !== undefined && !presentation) return undefined;
  return {
    version: 1,
    domain: "agent_instance",
    expiresAt: value.expiresAt,
    session: {
      principal: {
        ...Object.fromEntries(principalKeys.map((key) => [key, principal[key]])),
        hostId: typeof principal.hostId === "string" ? principal.hostId : "",
        runKind: principalRunKind,
        channelWriteAllowed,
      } as AgentInstanceRuntimeSession["principal"],
      run: runOut,
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
      ...hibernationClientVersions(session),
      ...(presentation ? { presentation } : {}),
    },
  };
}
