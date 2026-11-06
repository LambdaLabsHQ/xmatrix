import { isAgentStatus, isAgentInstanceRest, type SerializedAgentInstance } from "./authority-foundation.js";
import { parseAgentRegistrationKey, parseSpaceAgentRegistrationKey, sameAgentRegistration,
  type AgentRegistrationKey, type SpaceAgentRegistrationKey } from "./agent-registration.js";
import { hasControlCharacter } from "./field-validation.js";
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
export interface InstanceRecord extends Omit<SerializedAgentInstance, "activity" | "intent" | "files" | "runtimeState"> {
  channelId: string;
  channelInstanceId: string;
  agentName: string;
  registration: AgentRegistrationKey;
  revision: InstanceRevision;
  /** How the Space names the registration, at the registration's own version. */
  registrationPresentation?: RegistrationPresentation;
}

/** A Space's display facts for one registration. Another entity than the
 * Instance: it travels with Instance records but orders by its own `version`,
 * so a rename never needs, or waits for, an Instance revision. */
export interface RegistrationPresentation {
  key: SpaceAgentRegistrationKey;
  version: number;
  displayName: string;
}

export function parseInstanceRecord(value: unknown): InstanceRecord {
  if (!isPlainRecord(value) || !validRevision(value.revision) ||
      !["id", "channelId", "channelInstanceId", "agentName", "label"].every(key =>
        typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 300) ||
      !isAgentStatus(value.status) ||
      (value.rest !== undefined && !isAgentInstanceRest(value.rest)) ||
      ![value.connectedAt, value.lastSeenAt].every(time => typeof time === "string" && Number.isFinite(Date.parse(time)))) {
    throw new TypeError("Invalid Instance record");
  }
  const registration = parseAgentRegistrationKey(value.registration);
  const record = { ...value, registration,
    ...(value.registrationPresentation !== undefined
      ? { registrationPresentation: parseRegistrationPresentation(value.registrationPresentation, registration) } : {}) };
  for (const key of ["activity", "intent", "files", "runtimeState"]) delete (record as Record<string, unknown>)[key];
  return record as unknown as InstanceRecord;
}

/** A registration's display facts order by the registration's own version,
 * never by the revision of an Instance record that carried them. */
export function mergeRegistrationPresentation(current: RegistrationPresentation | undefined,
  incoming: RegistrationPresentation | undefined): RegistrationPresentation | undefined {
  if (!incoming || !current) return current ?? incoming;
  if (current.key.spaceId !== incoming.key.spaceId || !sameAgentRegistration(current.key, incoming.key)) {
    throw new TypeError("Registration presentation identity changed");
  }
  return incoming.version > current.version ? incoming : current;
}

/** The record kept by Instance revision, carrying the newest display facts any read of it had. */
export function withNewestRegistrationPresentation(kept: InstanceRecord,
  ...reads: readonly (InstanceRecord | undefined)[]): InstanceRecord {
  const newest = reads.reduce<RegistrationPresentation | undefined>(
    (held, read) => mergeRegistrationPresentation(held, read?.registrationPresentation), kept.registrationPresentation);
  return newest === kept.registrationPresentation ? kept : { ...kept, ...(newest ? { registrationPresentation: newest } : {}) };
}

/** A registration's display facts, only for the registration the record names. */
export function parseRegistrationPresentation(value: unknown, registration?: AgentRegistrationKey): RegistrationPresentation {
  if (!isPlainRecord(value) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
      typeof value.displayName !== "string" || value.displayName.length === 0 || value.displayName.length > 300 ||
      value.displayName !== value.displayName.trim() || hasControlCharacter(value.displayName)) {
    throw new TypeError("Invalid registration presentation");
  }
  const key = parseSpaceAgentRegistrationKey(value.key);
  if (registration && !sameAgentRegistration(key, registration)) {
    throw new TypeError("Registration presentation names another registration");
  }
  return { key, version: Number(value.version), displayName: value.displayName };
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
  return newerRevision(incoming.revision, current.revision) ? incoming : current;
}

/** Temporary work is owned by the current socket. It cannot connect an
 * Instance, change its durable status, or outlive its lifecycle version. */
export interface InstanceActivity extends Pick<SerializedAgentInstance, "activity" | "intent" | "files" | "runtimeState"> {
  instanceId: string;
  channelId: string;
  revision: InstanceRevision;
}

export function parseInstanceActivity(value: unknown): InstanceActivity {
  if (!isPlainRecord(value) || !validRevision(value.revision) ||
      ![value.instanceId, value.channelId].every(id => typeof id === "string" && id.length > 0 && id.length <= 300) ||
      ![value.activity, value.intent].every(text => text === undefined || typeof text === "string" && text.length <= 512) ||
      (value.files !== undefined && (!Array.isArray(value.files) || value.files.length > 64 ||
        !value.files.every(file => typeof file === "string" && file.length <= 512))) ||
      (value.runtimeState !== undefined && (!isPlainRecord(value.runtimeState) || JSON.stringify(value.runtimeState).length > 32_768))) {
    throw new TypeError("Invalid Instance activity");
  }
  return { instanceId: value.instanceId, channelId: value.channelId, revision: value.revision,
    ...(value.activity !== undefined ? { activity: value.activity } : {}),
    ...(value.intent !== undefined ? { intent: value.intent } : {}),
    ...(value.files !== undefined ? { files: value.files } : {}),
    ...(value.runtimeState !== undefined ? { runtimeState: value.runtimeState } : {}) } as InstanceActivity;
}

export function mergeInstanceActivity(current: InstanceActivity | undefined, incoming: InstanceActivity): InstanceActivity {
  if (!current) return incoming;
  if (current.instanceId !== incoming.instanceId || current.channelId !== incoming.channelId) {
    throw new TypeError("Instance activity identity changed");
  }
  return newerRevision(incoming.revision, current.revision) ? incoming : current;
}

function validRevision(value: unknown): value is InstanceRevision {
  return isPlainRecord(value) && Number.isSafeInteger(value.version) && Number(value.version) >= 1 &&
    Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0;
}

function newerRevision(after: InstanceRevision, before: InstanceRevision): boolean {
  return after.version > before.version || after.version === before.version && after.sequence > before.sequence;
}
