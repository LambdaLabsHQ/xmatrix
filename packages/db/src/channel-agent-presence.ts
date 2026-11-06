import { checkedStoredIso } from "./stored-values.js";
import {
  LIVE_AGENT_STATUS_SQL,
  localLlmUsage,
  type LlmUsage,
  agentFaceUrl,
  isLiveAgentStatus,
  isAgentInstanceOfflineReason,
  type AgentGoalStatus,
  type AgentInstanceRest,
  type AgentStatusChip,
  repoSummonReference,
  type ChannelMemberPresence,
  type InstanceRecord,
  type InstanceRevision,
  mergeInstanceRecord,
  withNewestRegistrationPresentation,
  type SerializedAgentInstance,
} from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";

import { channelCapabilityPredicate } from "./channel-capability-policy.js";
import type { DatabaseTransaction } from "./contracts.js";
import { DatabaseContractError } from "./errors.js";

const MAX_CHANNEL_SELECTORS = 20_200;
const MAX_ACTIVE_AGENT_INSTANCES = 512;
/** Channels with a live Instance returned by one reader-scoped list. */
const MAX_VISIBLE_LIVE_AGENT_CHANNELS = 200;
/** Resting Instances shown per Channel, newest first (docs/instance-sleep.md §5). */
export const MAX_RESTING_INSTANCES_PER_CHANNEL = 12;
const MAX_RESTING_AGENT_INSTANCES = 2_048; // the query's literal LIMIT
/** Instance ids one exact read answers for (the query's literal LIMIT). */
export const MAX_KNOWN_INSTANCE_IDS = 1_024;

/**
 * One Instance as it stands, complete in itself (protocol `InstanceRecord`),
 * with its owner's email when the Space shows it. `revision.version` is
 * `data.instances.version`, which every lifecycle write advances (launch,
 * connect, transition, rest, wake failure, reborn, handoff, stop);
 * `revision.sequence` orders one connection's reports within that version and
 * is 0 when the row holds no report made at its current version.
 */
export type AgentInstanceRecord = InstanceRecord & { email?: string };

interface InstanceRecordRow extends QueryResultRow {
  instance_id: string;
  instance_version: string | number;
  presence_version?: unknown;
  presence_sequence?: unknown;
  instance_usage?: LlmUsage | null;
  instance_model?: string | null;
  instance_effort?: string | null;
  instance_status_chips?: unknown;
  instance_goal?: unknown;
  instance_git_branch?: string | null;
  registration_space?: string | null;
  registration_display_name?: string | null;
  registration_version?: string | number | null;
  channel_id: string;
  channel_instance_id: string | number;
  status: string;
  run_status: string;
  created_at: string | Date;
  updated_at: string | Date;
  registration_owner: string;
  registration_machine: string;
  registration_harness: string;
  workspace_machine_id: string | null;
  workspace_canonical_cwd: string | null;
  run_metadata_json: Record<string, unknown> | null;
  agent_name: string;
  owner_email: string | null;
  /** Why its live connection last reported it unreachable (machine offline), as a checkpoint of that connection. */
  shown_offline_reason?: string | null;
  rest_state?: string | null;
  rest_reason?: string | null;
  waking?: boolean | null;
  launch_in_flight?: boolean | null;
}

const iso = (value: string | Date) => checkedStoredIso(value,
  () => new DatabaseContractError("Agent presence timestamp is invalid"));

function metadataText(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The Run metadata fields a Presence entry shows. Only they leave PostgreSQL:
 * a Run's whole metadata averages 3.5 KB, and Presence is read on every live
 * fanout, so returning all of it made Presence a leading source of egress.
 */
const PRESENCE_RUN_METADATA_KEYS = ["routedAs", "clientVersion", "machineId", "hostname", "hostId",
  "hostName", "cwd", "canonicalCwd", "workspaceName", "gitBranch", "remoteRepo"] as const;
const PRESENCE_RUN_METADATA_SQL = `jsonb_strip_nulls(jsonb_build_object(${PRESENCE_RUN_METADATA_KEYS
  .map((key) => `'${key}',r.metadata_json->'${key}'`).join(",")}))`;
/**
 * Durable presentation a list can show without the runtime snapshot: what the
 * connection persisted with the report its revision names. Activity, files,
 * intent and runtimeState are temporary work and stay off this read.
 */
const DURABLE_PRESENTATION_SQL = `i.presentation_json->>'model' AS instance_model,
        i.presentation_json->>'effort' AS instance_effort,
        i.presentation_json->'statusChips' AS instance_status_chips,
        i.presentation_json->'goal' AS instance_goal,
        i.presentation_json->>'gitBranch' AS instance_git_branch`;
/** What every Instance record is made of, whichever read selects it. */
const RECORD_COLUMNS_SQL = `i.instance_id,i.channel_id,i.channel_instance_id,i.status,r.status AS run_status,
        i.version AS instance_version,i.presentation_json->'presenceVersion' AS presence_version,
        i.presentation_json->'presenceSequence' AS presence_sequence,
        i.presentation_json->>'offlineReason' AS shown_offline_reason,
        i.created_at,i.updated_at,i.presentation_json->'usage' AS instance_usage,${DURABLE_PRESENTATION_SQL},
        r.workspace_machine_id,
        r.workspace_canonical_cwd,${PRESENCE_RUN_METADATA_SQL} AS run_metadata_json,
        COALESCE(s.display_name,r.metadata_json->>'agentName','Agent') AS agent_name,
        owner.email AS owner_email,
        b.owner_user_id AS registration_owner,b.machine_id AS registration_machine,b.harness AS registration_harness,
        s.space_id AS registration_space,s.display_name AS registration_display_name,s.version AS registration_version`;
/** Why an offline Instance is still its Channel's (docs/instance-sleep.md §5). */
const REST_COLUMNS_SQL = `i.rest_state,i.rest_reason,
        (r.status='starting' OR EXISTS (SELECT 1 FROM data.agent_reborn_intents intent
          WHERE intent.source_instance_id=i.instance_id AND intent.state IN ('waiting','prepared'))) AS waking,
        EXISTS (SELECT 1 FROM data.agent_launches launch WHERE launch.instance_id=i.instance_id
          AND launch.state IN ('prepared','queued','admitted','spawned')) AS launch_in_flight`;
/** The rows a record joins, in the Space bound to `spaceSql`. */
function recordFromSql(spaceSql: string): string {
  return `FROM data.instances i
      JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
      JOIN data.run_agent_registrations b ON b.run_id=r.run_id AND b.space_id=${spaceSql}
      LEFT JOIN data.space_agent_registrations s ON s.space_id=b.space_id AND s.owner_user_id=b.owner_user_id
        AND s.machine_id=b.machine_id AND s.harness=b.harness
      LEFT JOIN data.space_members owner ON owner.space_id=${spaceSql} AND owner.user_id=b.owner_user_id`;
}

function harnessAvatarUrl(harness: string): string | undefined {
  return agentFaceUrl(harness);
}

function selectedChannels(channelIds: readonly string[]): string[] {
  const selected = [...new Set(channelIds)];
  if (selected.length > MAX_CHANNEL_SELECTORS) {
    throw new DatabaseContractError("Agent presence Channel selector limit exceeded");
  }
  return selected;
}

/**
 * Every Agent Instance record the exact Channels selected by an authoritative
 * PostgreSQL catalog read show: all live Instances, and the newest few resting
 * ones. It is a bounded window, not the Channel's whole roster: an Instance
 * missing from it is unknown to the reader, never gone. Every selected Channel
 * has an entry, empty when it shows no Instance.
 */
export async function loadChannelInstanceRecords(
  transaction: DatabaseTransaction,
  spaceId: string,
  channelIds: readonly string[],
): Promise<Map<string, AgentInstanceRecord[]>> {
  const selected = selectedChannels(channelIds);
  const byChannel = new Map<string, AgentInstanceRecord[]>(selected.map((channelId) => [channelId, []]));
  if (selected.length === 0) return byChannel;
  const live = await transaction.query<InstanceRecordRow>({
    name: "channel_agent_presence_v11",
    text: `SELECT ${RECORD_COLUMNS_SQL}
      ${recordFromSql("$1")}
      WHERE i.channel_id=ANY($2::text[])
        AND i.status IN (${LIVE_AGENT_STATUS_SQL})
        AND r.status IN ('running','stopping')
      ORDER BY i.channel_id,i.channel_instance_id,i.instance_id
      LIMIT 513`,
    values: [spaceId, selected],
    maxRows: MAX_ACTIVE_AGENT_INSTANCES + 1,
  });
  if (live.length > MAX_ACTIVE_AGENT_INSTANCES) {
    throw new DatabaseContractError("Active Agent Instance presence limit exceeded");
  }
  for (const row of live) {
    const record = instanceRecord(row);
    if (!isLiveAgentStatus(record.status) && !record.offlineReason) {
      throw new DatabaseContractError("Agent presence status is invalid");
    }
    placeRecord(byChannel, record);
  }
  // A resting Instance is offline but still the Channel's: the next message
  // wakes it (docs/instance-sleep.md §5). Newest first, a bounded few per
  // Channel; unlike live Instances, a Channel with more simply shows fewer.
  const resting = await transaction.query<InstanceRecordRow>({
    name: "channel_agent_resting_presence_v7",
    text: `SELECT * FROM (SELECT ${RECORD_COLUMNS_SQL},${REST_COLUMNS_SQL},
        row_number() OVER (PARTITION BY i.channel_id ORDER BY i.updated_at DESC,i.instance_id) AS rest_rank
      ${recordFromSql("$1")}
      WHERE i.channel_id=ANY($2::text[]) AND i.status='offline'
        AND (i.rest_state IN ('sleeping','interrupted','wake_failed')
          OR (i.rest_state IS NULL AND r.status IN ('starting','running') AND EXISTS (
            SELECT 1 FROM data.agent_launches launch WHERE launch.instance_id=i.instance_id
              AND launch.state IN ('prepared','queued','admitted','spawned'))))) resting
      WHERE resting.rest_rank<=$3
      ORDER BY resting.channel_id,resting.channel_instance_id,resting.instance_id
      LIMIT 2048`,
    values: [spaceId, selected, MAX_RESTING_INSTANCES_PER_CHANNEL],
    maxRows: MAX_RESTING_AGENT_INSTANCES,
  });
  for (const row of resting) {
    const record = instanceRecord(row);
    if (!record.rest) throw new DatabaseContractError("Resting Agent presence state is invalid");
    placeRecord(byChannel, record);
  }
  return byChannel;
}

/**
 * Exactly these Instances, as they stand now, wherever they stand: live,
 * resting or gone. Only Instances of `channelIds` (Channels the caller has
 * authorized for this reader) answer; every other id, including one that no
 * longer exists, is named in `missingInstanceIds`. Unlike absence from a
 * Channel window, a missing id here is an answer: the reader holds nothing the
 * Space can still show it.
 */
export async function loadAgentInstanceRecordsById(
  transaction: DatabaseTransaction,
  spaceId: string,
  channelIds: readonly string[],
  instanceIds: readonly string[],
): Promise<{ records: AgentInstanceRecord[]; missingInstanceIds: string[] }> {
  const requested = [...new Set(instanceIds)];
  if (requested.some((id) => typeof id !== "string" || id.length === 0 || id.length > 300)) {
    throw new DatabaseContractError("Instance id is invalid");
  }
  if (requested.length > MAX_KNOWN_INSTANCE_IDS) {
    throw new DatabaseContractError("Known Instance id limit exceeded");
  }
  const channels = selectedChannels(channelIds);
  if (requested.length === 0 || channels.length === 0) return { records: [], missingInstanceIds: requested };
  const rows = await transaction.query<InstanceRecordRow>({
    name: "agent_instance_records_by_id_v1",
    text: `SELECT ${RECORD_COLUMNS_SQL},${REST_COLUMNS_SQL}
      ${recordFromSql("$1")}
      WHERE i.instance_id=ANY($2::text[]) AND i.channel_id=ANY($3::text[])
      ORDER BY i.channel_id,i.channel_instance_id,i.instance_id
      LIMIT 1024`,
    values: [spaceId, requested, channels],
    maxRows: MAX_KNOWN_INSTANCE_IDS,
  });
  const allowed = new Set(channels);
  const records = rows.map((row) => {
    if (!allowed.has(row.channel_id)) {
      throw new DatabaseContractError("Agent presence escaped its selected Channel scope");
    }
    return instanceRecord(row);
  });
  const found = new Set(records.map((record) => record.id));
  return { records, missingInstanceIds: requested.filter((id) => !found.has(id)) };
}

/** The Channel an Instance id names: stored ids are `<channelId>:<ordinal>` (0084). */
function instanceChannelId(instanceId: string): string | undefined {
  const at = instanceId.lastIndexOf(":");
  return at > 0 && /^[1-9][0-9]{0,15}$/u.test(instanceId.slice(at + 1)) ? instanceId.slice(0, at) : undefined;
}

/** A Channel read's Agent Instances, in both shapes its answer carries. */
export interface ChannelInstances {
  /** The window in the legacy member-keyed shape, for `memberPresence`. */
  readonly memberPresence: Map<string, Record<string, ChannelMemberPresence>>;
  /** Each selected Channel's records: its window and, for ids its reader holds, their exact answer. */
  readonly records: Map<string, AgentInstanceRecord[]>;
  /** Set when the reader named the ids it holds: per selected Channel, those of its ids that no longer answer. */
  readonly missing?: Map<string, string[]>;
}

/**
 * The Agent Instances of the exact Channels an authoritative catalog read
 * selected. With `knownInstanceIds` (the records its reader holds), each of
 * those Channels also answers for every one of its ids exactly, ended ones
 * included, so the reader can retire what it holds without inferring anything
 * from the window. Ids of Channels outside the selection get no answer: the
 * Channel's own absence from the read is that answer.
 */
export async function readChannelInstances(
  transaction: DatabaseTransaction,
  spaceId: string,
  channelIds: readonly string[],
  knownInstanceIds?: readonly string[],
): Promise<ChannelInstances> {
  const window = await loadChannelInstanceRecords(transaction, spaceId, channelIds);
  const memberPresence = channelMemberPresence(window);
  if (knownInstanceIds === undefined) return { memberPresence, records: window };
  if (!Array.isArray(knownInstanceIds) || knownInstanceIds.length > MAX_KNOWN_INSTANCE_IDS) {
    throw new DatabaseContractError("Known Instance id limit exceeded");
  }
  const known = [...new Set(knownInstanceIds)].filter((id) => {
    if (typeof id !== "string" || id.length === 0 || id.length > 300) {
      throw new DatabaseContractError("Instance id is invalid");
    }
    const channelId = instanceChannelId(id);
    return channelId !== undefined && window.has(channelId);
  });
  const exact = await loadAgentInstanceRecordsById(transaction, spaceId, [...window.keys()], known);
  const records = new Map<string, AgentInstanceRecord[]>();
  for (const [channelId, windowRecords] of window) {
    const byId = new Map(windowRecords.map((record) => [record.id, record]));
    for (const record of exact.records) {
      if (record.channelId !== channelId) continue;
      const held = byId.get(record.id);
      // The record goes by Instance revision; its registration's name by the registration's own version.
      byId.set(record.id, withNewestRegistrationPresentation(mergeInstanceRecord(held, record), held, record) as
        AgentInstanceRecord);
    }
    records.set(channelId, [...byId.values()].sort((left, right) =>
      Number(left.channelInstanceId) - Number(right.channelInstanceId)));
  }
  const missing = new Map<string, string[]>([...window.keys()].map((channelId) => [channelId, []]));
  for (const id of exact.missingInstanceIds) missing.get(instanceChannelId(id)!)?.push(id);
  return { memberPresence, records, missing };
}

/** Put one Channel's records, and its exact misses when asked, on its serialized answer. */
export function withChannelInstanceRecords(
  channel: Record<string, unknown>,
  instances: ChannelInstances,
  channelId: string,
): Record<string, unknown> {
  channel.instanceRecords = instances.records.get(channelId) ?? [];
  if (instances.missing) channel.missingInstanceIds = instances.missing.get(channelId) ?? [];
  return channel;
}

/** The legacy member-keyed shape of Channel windows, for readers of `memberPresence`. */
export function channelMemberPresence(
  records: ReadonlyMap<string, readonly AgentInstanceRecord[]>,
): Map<string, Record<string, ChannelMemberPresence>> {
  const byChannel = new Map<string, Record<string, ChannelMemberPresence>>();
  for (const [channelId, channelRecords] of records) {
    if (channelRecords.length === 0) continue;
    const channelPresence: Record<string, ChannelMemberPresence> = {};
    for (const record of channelRecords) channelPresence[record.id] = memberPresenceEntry(record);
    byChannel.set(channelId, channelPresence);
  }
  return byChannel;
}

/**
 * The Agent Instance Presence of the exact Channels selected by an
 * authoritative PostgreSQL catalog transaction, in the legacy member-keyed
 * shape: the window `loadChannelInstanceRecords` reads.
 */
export async function loadChannelAgentPresence(
  transaction: DatabaseTransaction,
  spaceId: string,
  channelIds: readonly string[],
): Promise<Map<string, Record<string, ChannelMemberPresence>>> {
  return channelMemberPresence(await loadChannelInstanceRecords(transaction, spaceId, channelIds));
}

/**
 * Live Instances in Channels this principal may read. The list is the
 * Postgres projection, not a runtime snapshot: one statement names the
 * Channels, then the shared presence read fills them.
 */
export async function loadVisibleLiveAgentPresence(
  transaction: DatabaseTransaction,
  spaceId: string,
  principal: { kind: "user" | "agent"; id: string },
): Promise<Map<string, Record<string, ChannelMemberPresence>>> {
  const channels = await transaction.query<{ channel_id: string }>({
    name: "visible_live_agent_channels_v2",
    text: `SELECT c.channel_id FROM data.channels c
      WHERE c.space_id=$1
        AND ${channelCapabilityPredicate({
          capability: "catalog_read", channelAlias: "c",
          principalKindSql: "$2", principalIdSql: "$3",
        })}
        AND EXISTS (
          SELECT 1 FROM data.instances i
          JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
          WHERE i.channel_id=c.channel_id
            AND i.status IN (${LIVE_AGENT_STATUS_SQL})
            AND r.status IN ('running','stopping')
        )
      ORDER BY c.channel_id
      LIMIT ${MAX_VISIBLE_LIVE_AGENT_CHANNELS}`,
    values: [spaceId, principal.kind, principal.id],
    maxRows: MAX_VISIBLE_LIVE_AGENT_CHANNELS,
  });
  return loadChannelAgentPresence(transaction, spaceId, channels.map((row) => row.channel_id));
}

/** Model, effort and chips stored on the Instance. A value this read cannot show is omitted. */
function durableInstancePresentation(row: InstanceRecordRow): Pick<
  SerializedAgentInstance, "model" | "effort" | "statusChips" | "goal"
> {
  const model = boundedPresentationText(row.instance_model, 128);
  const effort = boundedPresentationText(row.instance_effort, 64);
  const statusChips = durableStatusChips(row.instance_status_chips);
  const goal = durableGoal(row.instance_goal);
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(statusChips ? { statusChips } : {}),
    ...(goal ? { goal } : {}),
  };
}

const GOAL_TEXT_LIMITS = { objective: 1_024, status: 128, updatedAt: 64, reason: 512, nextAction: 512 } as const;
const GOAL_COUNTERS = ["tokensUsed", "timeUsedSeconds", "iterationCount", "contextUsed", "toolCallCount"] as const;

/** The goal the connection persisted, as far as this read can show it; anything else is left out. */
function durableGoal(value: unknown): AgentGoalStatus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const goal: AgentGoalStatus = typeof source.active === "boolean" ? { active: source.active } : {};
  for (const [key, limit] of Object.entries(GOAL_TEXT_LIMITS) as [keyof typeof GOAL_TEXT_LIMITS, number][]) {
    const text = boundedPresentationText(source[key], limit);
    if (text) goal[key] = text;
  }
  for (const key of GOAL_COUNTERS) {
    const number = source[key];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) goal[key] = number;
  }
  return Object.keys(goal).length > 0 ? goal : undefined;
}

function boundedPresentationText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

function durableStatusChips(value: unknown): AgentStatusChip[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return undefined;
  const chips: AgentStatusChip[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const chip = item as Record<string, unknown>;
    const id = boundedPresentationText(chip.id, 64);
    const label = boundedPresentationText(chip.label, 64);
    if (!id || !label) return undefined;
    const next: AgentStatusChip = { id, label };
    if (chip.value !== undefined) {
      const shown = boundedPresentationText(chip.value, 128);
      if (!shown) return undefined;
      next.value = shown;
    }
    if (chip.percent !== undefined) {
      if (typeof chip.percent !== "number" || chip.percent < 0 || chip.percent > 100) return undefined;
      next.percent = chip.percent;
    }
    if (chip.source !== undefined) {
      const source = boundedPresentationText(chip.source, 64);
      if (!source) return undefined;
      next.source = source;
    }
    if (chip.resetAt !== undefined) {
      const resetAt = boundedPresentationText(chip.resetAt, 40);
      if (!resetAt) return undefined;
      next.resetAt = resetAt;
    }
    if (chip.parameterKind !== undefined) {
      if (chip.parameterKind !== "boolean" && chip.parameterKind !== "enum") return undefined;
      next.parameterKind = chip.parameterKind;
    }
    chips.push(next);
  }
  return chips;
}

/**
 * How a row stands. A live row whose Run has ended, and an offline one with
 * no rest and no first launch in flight, have left the Channel; both windows
 * and exact reads classify with this one rule.
 */
function recordState(row: InstanceRecordRow): {
  status: SerializedAgentInstance["status"];
  rest?: AgentInstanceRest;
  offlineReason?: SerializedAgentInstance["offlineReason"];
} {
  if (isLiveAgentStatus(row.status)) {
    if (row.run_status !== "running" && row.run_status !== "stopping") return { status: "offline" };
    // Connected, but its machine is not: shown offline, and back as soon as
    // the connection's next checkpoint says the machine returned.
    return isAgentInstanceOfflineReason(row.shown_offline_reason)
      ? { status: "offline", offlineReason: row.shown_offline_reason } : { status: row.status };
  }
  if (row.status !== "offline") throw new DatabaseContractError("Agent presence status is invalid");
  if (row.rest_state === "wake_failed") return { status: "offline", rest: "wake_failed" };
  // A failed wake's successor never reached its daemon, so its Run may still
  // read `starting`; the failure, not that Run, is the Instance's state.
  if (row.rest_state === "sleeping" || row.rest_state === "interrupted") {
    return { status: "offline", rest: row.waking === true ? "waking" : row.rest_state };
  }
  // A launched Instance that has not connected yet has no rest; it is waking
  // for the first time, and the Channel shows it from the summon onwards.
  if ((row.rest_state === null || row.rest_state === undefined) && row.launch_in_flight === true &&
      (row.run_status === "starting" || row.run_status === "running")) {
    return { status: "offline", rest: "waking" };
  }
  if (row.rest_state !== null && row.rest_state !== undefined && row.rest_state !== "stopped") {
    throw new DatabaseContractError("Resting Agent presence state is invalid");
  }
  return { status: "offline" };
}

function revisionOf(row: InstanceRecordRow): InstanceRevision {
  const version = Number(row.instance_version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DatabaseContractError("Agent presence version is invalid");
  }
  const sequence = Number(row.presence_sequence);
  // A report made under an earlier version says nothing about this one.
  return Number(row.presence_version) === version && Number.isSafeInteger(sequence) && sequence > 0
    ? { version, sequence } : { version, sequence: 0 };
}

/** One Instance's record. A Run's actor is its Instance, as in runtime
 * presence and message senders; a registration is launch configuration. */
function instanceRecord(row: InstanceRecordRow): AgentInstanceRecord {
  const ordinal = Number(row.channel_instance_id);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new DatabaseContractError("Agent presence ordinal is invalid");
  }
  const { status, rest, offlineReason: shownOffline } = recordState(row);
  const runMetadata = row.run_metadata_json ?? {};
  const remoteRepo = metadataText(runMetadata, "remoteRepo");
  const repository = remoteRepo ? repoSummonReference(remoteRepo) : undefined;
  const label = row.agent_name;
  const channelInstanceId = String(ordinal);
  const usage = localLlmUsage(row.instance_usage ?? undefined);
  return {
    id: row.instance_id,
    channelInstanceId,
    channelId: row.channel_id,
    label: `${label}:${channelInstanceId}`,
    connectedAt: iso(row.created_at),
    lastSeenAt: iso(row.updated_at),
    status,
    ...(repository ? { repository } : {}),
    ...(usage ? { usage } : {}),
    ...(rest ? { rest } : {}),
    ...(rest === "wake_failed" && row.rest_reason ? { restReason: row.rest_reason } : {}),
    // A message could not wake it: its machine is offline, and wakes it on reconnect.
    ...((rest === "sleeping" || rest === "interrupted") && isAgentInstanceOfflineReason(row.rest_reason)
      ? { offlineReason: row.rest_reason } : {}),
    ...(shownOffline ? { offlineReason: shownOffline } : {}),
    ...(metadataText(runMetadata, "clientVersion")
      ? { clientVersion: metadataText(runMetadata, "clientVersion") }
      : {}),
    ...(metadataText(runMetadata, "machineId") || row.workspace_machine_id
      ? { machineId: metadataText(runMetadata, "machineId") || row.workspace_machine_id! }
      : {}),
    ...(metadataText(runMetadata, "hostname")
      ? { hostname: metadataText(runMetadata, "hostname") }
      : {}),
    ...(metadataText(runMetadata, "hostname") || metadataText(runMetadata, "hostId")
      ? { hostId: metadataText(runMetadata, "hostname") || metadataText(runMetadata, "hostId") }
      : {}),
    ...(metadataText(runMetadata, "hostname") || metadataText(runMetadata, "hostName")
      ? { hostName: metadataText(runMetadata, "hostname") || metadataText(runMetadata, "hostName") }
      : {}),
    ...(metadataText(runMetadata, "cwd") || metadataText(runMetadata, "canonicalCwd") ||
        row.workspace_canonical_cwd
      ? { cwd: metadataText(runMetadata, "cwd") ||
          metadataText(runMetadata, "canonicalCwd") || row.workspace_canonical_cwd! }
      : {}),
    ...(metadataText(runMetadata, "workspaceName")
      ? { workspaceName: metadataText(runMetadata, "workspaceName") }
      : {}),
    // The branch the connection last reported, else the one its Run started on.
    ...(boundedPresentationText(row.instance_git_branch, 256) || metadataText(runMetadata, "gitBranch")
      ? { gitBranch: boundedPresentationText(row.instance_git_branch, 256) || metadataText(runMetadata, "gitBranch") }
      : {}),
    ...durableInstancePresentation(row),
    agentName: label,
    registration: { ownerUserId: row.registration_owner, machineId: row.registration_machine,
      harness: row.registration_harness },
    ...registrationPresentationOf(row),
    ...(row.owner_email ? { email: row.owner_email } : {}),
    revision: revisionOf(row),
  };
}

/**
 * How the Space names the Instance's registration, with that registration's
 * own version. It rides with the record but is another entity: a rename moves
 * this version and never the Instance revision. Absent without a Space row.
 */
function registrationPresentationOf(row: InstanceRecordRow): Pick<AgentInstanceRecord, "registrationPresentation"> {
  if (row.registration_version === null || row.registration_version === undefined) return {};
  const version = Number(row.registration_version);
  const displayName = boundedPresentationText(row.registration_display_name, 300);
  if (!Number.isSafeInteger(version) || version < 1 || !displayName || !row.registration_space) {
    throw new DatabaseContractError("Agent registration presentation is invalid");
  }
  return { registrationPresentation: {
    key: { spaceId: row.registration_space, ownerUserId: row.registration_owner,
      machineId: row.registration_machine, harness: row.registration_harness },
    version, displayName,
  } };
}

function placeRecord(byChannel: Map<string, AgentInstanceRecord[]>, record: AgentInstanceRecord): void {
  const channelRecords = byChannel.get(record.channelId);
  if (!channelRecords) throw new DatabaseContractError("Agent presence escaped its selected Channel scope");
  channelRecords.push(record);
}

/** The legacy Presence entry of one record: the Instance under its registration's member. */
function memberPresenceEntry(record: AgentInstanceRecord): ChannelMemberPresence {
  const { agentName, registration, email, revision: _revision, registrationPresentation: _presentation,
    ...instance } = record;
  const avatarUrl = harnessAvatarUrl(registration.harness);
  return {
    kind: "agent",
    label: agentName,
    registration,
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    lastSeenAt: instance.lastSeenAt,
    usage: instance.usage,
    instances: [instance],
  };
}
