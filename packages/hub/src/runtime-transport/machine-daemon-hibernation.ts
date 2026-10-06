import type { MachineDaemonRuntimeSession } from "./machine-daemon-port";
import {
  hibernationBoundedJson,
  hibernationBoundedString,
  hibernationHasExactKeys,
  hibernationHasOnlyKeys,
  hibernationRecord,
  hibernationValidDate,
  hibernationValidExpiry,
  nextRuntimeHibernationExpiry,
} from "./hibernation-bounds";

export interface MachineDaemonHibernationAttachment {
  version: 1;
  domain: "machine_daemon";
  expiresAt: string;
  session: MachineDaemonRuntimeSession;
}

export function serializeMachineDaemonHibernationAttachment(
  session: Readonly<MachineDaemonRuntimeSession>,
): MachineDaemonHibernationAttachment {
  const parsed = parseMachineDaemonHibernationAttachment({ version: 1, domain: "machine_daemon",
    expiresAt: nextRuntimeHibernationExpiry(), session });
  if (!parsed) throw new Error("Machine Daemon session cannot be serialized as a bounded hibernation attachment");
  return parsed;
}

export function parseMachineDaemonHibernationAttachment(value: unknown): MachineDaemonHibernationAttachment | undefined {
  if (!hibernationRecord(value) || !hibernationHasExactKeys(value, ["version", "domain", "expiresAt", "session"]) ||
      value.version !== 1 || value.domain !== "machine_daemon" || !hibernationValidExpiry(value.expiresAt) || !hibernationBoundedJson(value)) return undefined;
  const session = value.session;
  const keys = ["principal", "connectionEpoch", "displayName", "capabilities", "machineMetadata", "connectedAt", "lastSeenAt"] as const;
  if (!hibernationRecord(session) ||
      !hibernationHasOnlyKeys(session, [...keys, "clientVersion", "clientProtocolVersion"]) ||
      !keys.every((key) => key in session) || !hibernationBoundedString(session.displayName) ||
      !Number.isSafeInteger(session.connectionEpoch) || (session.connectionEpoch as number) < 1 ||
      !(session.clientVersion === undefined || hibernationBoundedString(session.clientVersion)) ||
      !(session.clientProtocolVersion === undefined ||
        (Number.isSafeInteger(session.clientProtocolVersion) && (session.clientProtocolVersion as number) > 0)) ||
      !Array.isArray(session.capabilities) || session.capabilities.length > 64 ||
      !session.capabilities.every((item) => hibernationBoundedString(item, 128)) ||
      !hibernationRecord(session.machineMetadata) || !hibernationValidDate(session.connectedAt) || !hibernationValidDate(session.lastSeenAt)) return undefined;
  const principal = session.principal;
  if (!hibernationRecord(principal) || !hibernationHasOnlyKeys(principal, ["ownerUserId", "ownerEmail", "machineId", "hostId", "hostName", "hostname"]) ||
      !["ownerUserId", "ownerEmail", "machineId"].every((key) => hibernationBoundedString(principal[key])) ||
      !(principal.hostId === undefined || principal.hostId === "" || hibernationBoundedString(principal.hostId, 160)) ||
      !(principal.hostName === undefined || hibernationBoundedString(principal.hostName)) ||
      !(principal.hostname === undefined || principal.hostname === "" || hibernationBoundedString(principal.hostname, 160))) return undefined;
  return {
    version: 1,
    domain: "machine_daemon",
    expiresAt: value.expiresAt,
    session: {
      principal: { ownerUserId: principal.ownerUserId as string, ownerEmail: principal.ownerEmail as string,
        machineId: principal.machineId as string, hostId: principal.hostId as string || "",
        ...(principal.hostname ? { hostname: principal.hostname as string } : {}),
        ...(principal.hostName ? { hostName: principal.hostName as string } : {}) },
      connectionEpoch: session.connectionEpoch as number,
      displayName: session.displayName,
      ...(session.clientVersion ? { clientVersion: session.clientVersion } : {}),
      ...(typeof session.clientProtocolVersion === "number"
        ? { clientProtocolVersion: session.clientProtocolVersion }
        : {}),
      capabilities: Object.freeze([...new Set(session.capabilities)]),
      machineMetadata: Object.freeze({ ...session.machineMetadata }),
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt,
    },
  };
}
