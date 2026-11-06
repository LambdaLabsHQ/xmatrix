import { isAgentStatus, isAgentInstanceRest, type SerializedAgentInstance } from "./authority-foundation.js";
import { parseAgentRegistrationKey, sameAgentRegistration, type AgentRegistrationKey } from "./agent-registration.js";
import { isPlainRecord } from "./plain-record.js";

/** The Instance row orders lifecycle changes; its current socket orders reports
 * within that row version. Neither clock is inferred from arrival or wall time. */
export interface InstanceRevision {
  version: number;
  sequence: number;
}

/** A Hub-owned fact, complete enough to stand alone on every delivery path.
 * Offline with no rest or offlineReason is an explicit terminal record.
 * A missing record says nothing about whether an Instance is connected. */
export interface InstanceRecord extends SerializedAgentInstance {
  channelId: string;
  channelInstanceId: string;
  agentName: string;
  registration: AgentRegistrationKey;
  revision: InstanceRevision;
}

export function parseInstanceRecord(value: unknown): InstanceRecord {
  if (!isPlainRecord(value) || !isPlainRecord(value.revision) ||
      !Number.isSafeInteger(value.revision.version) || Number(value.revision.version) < 1 ||
      !Number.isSafeInteger(value.revision.sequence) || Number(value.revision.sequence) < 0 ||
      !["id", "channelId", "channelInstanceId", "agentName", "label"].every(key =>
        typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 300) ||
      !isAgentStatus(value.status) ||
      (value.rest !== undefined && !isAgentInstanceRest(value.rest)) ||
      ![value.connectedAt, value.lastSeenAt].every(time => typeof time === "string" && Number.isFinite(Date.parse(time)))) {
    throw new TypeError("Invalid Instance record");
  }
  return { ...value, registration: parseAgentRegistrationKey(value.registration) } as unknown as InstanceRecord;
}

/** The same rule for a read, a live report, a replay and an explicit terminal
 * record. There is no special authority attached to an array containing it. */
export function mergeInstanceRecord(current: InstanceRecord | undefined, incoming: InstanceRecord): InstanceRecord {
  if (!current) return incoming;
  if (current.id !== incoming.id || current.channelId !== incoming.channelId ||
      current.channelInstanceId !== incoming.channelInstanceId ||
      !sameAgentRegistration(current.registration, incoming.registration)) {
    throw new TypeError("Instance record identity changed");
  }
  const before = current.revision;
  const after = incoming.revision;
  return after.version > before.version || after.version === before.version && after.sequence > before.sequence
    ? incoming : current;
}
