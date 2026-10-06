import { checkedStoredIso } from "./stored-values.js";
import {
  LIVE_AGENT_STATUS_SQL,
  localLlmUsage,
  type LlmUsage,
  agentAvatarUrlFromMetadata,
  isLiveAgentStatus,
  type AgentInstanceRest,
  type AgentStatusChip,
  normalizeAgentPresetRuntime,
  type ChannelMemberPresence,
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
const XMATRIX_MANAGEMENT_LABEL = "xMatrix";

interface ChannelAgentPresenceRow extends QueryResultRow {
  instance_id: string;
  instance_usage?: LlmUsage | null;
  instance_model?: string | null;
  instance_effort?: string | null;
  instance_status_chips?: unknown;
  channel_id: string;
  channel_instance_id: string | number;
  status: string;
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
  rest_state?: string | null;
  rest_reason?: string | null;
  waking?: boolean | null;
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
  "hostName", "cwd", "canonicalCwd", "workspaceName", "gitBranch"] as const;
const PRESENCE_RUN_METADATA_SQL = `jsonb_strip_nulls(jsonb_build_object(${PRESENCE_RUN_METADATA_KEYS
  .map((key) => `'${key}',r.metadata_json->'${key}'`).join(",")}))`;
/**
 * Durable presentation a list can show without the runtime snapshot. Activity,
 * files, intent, runtimeState and goal stay off this read; live frames fill them.
 */
const DURABLE_PRESENTATION_SQL = `i.presentation_json->>'model' AS instance_model,
        i.presentation_json->>'effort' AS instance_effort,
        i.presentation_json->'statusChips' AS instance_status_chips`;

function harnessAvatarUrl(harness: string): string | undefined {
  return agentAvatarUrlFromMetadata({}, normalizeAgentPresetRuntime(harness) ?? harness);
}

/**
 * Reads the complete, bounded Agent Instance Presence projection for the exact
 * Channels selected by an authoritative PostgreSQL catalog transaction.
 */
export async function loadChannelAgentPresence(
  transaction: DatabaseTransaction,
  spaceId: string,
  channelIds: readonly string[],
): Promise<Map<string, Record<string, ChannelMemberPresence>>> {
  const selected = [...new Set(channelIds)];
  const selectedSet = new Set(selected);
  const byChannel = new Map<string, Record<string, ChannelMemberPresence>>();
  if (selected.length === 0) return byChannel;
  if (selected.length > MAX_CHANNEL_SELECTORS) {
    throw new DatabaseContractError("Agent presence Channel selector limit exceeded");
  }
  const rows = await transaction.query<ChannelAgentPresenceRow>({
    name: "channel_agent_presence_v8",
    text: `SELECT i.instance_id,i.channel_id,i.channel_instance_id,i.status,
        i.created_at,i.updated_at,i.presentation_json->'usage' AS instance_usage,${DURABLE_PRESENTATION_SQL},
        r.workspace_machine_id,
        r.workspace_canonical_cwd,${PRESENCE_RUN_METADATA_SQL} AS run_metadata_json,
        COALESCE(s.display_name,r.metadata_json->>'agentName','Agent') AS agent_name,
        owner.email AS owner_email,
        b.owner_user_id AS registration_owner,b.machine_id AS registration_machine,b.harness AS registration_harness
      FROM data.instances i
      JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
      JOIN data.run_agent_registrations b ON b.run_id=r.run_id AND b.space_id=$1
      LEFT JOIN data.space_agent_registrations s ON s.space_id=b.space_id AND s.owner_user_id=b.owner_user_id
        AND s.machine_id=b.machine_id AND s.harness=b.harness
      LEFT JOIN data.space_members owner ON owner.space_id=$1 AND owner.user_id=b.owner_user_id
      WHERE i.channel_id=ANY($2::text[])
        AND i.status IN (${LIVE_AGENT_STATUS_SQL})
        AND r.status IN ('running','stopping')
        AND COALESCE(r.metadata_json->>'routedAs','')<>'management_channel_about'
      ORDER BY i.channel_id,i.channel_instance_id,i.instance_id
      LIMIT 513`,
    values: [spaceId, selected],
    maxRows: MAX_ACTIVE_AGENT_INSTANCES + 1,
  });
  if (rows.length > MAX_ACTIVE_AGENT_INSTANCES) {
    throw new DatabaseContractError("Active Agent Instance presence limit exceeded");
  }
  for (const row of rows) {
    if (!isLiveAgentStatus(row.status)) {
      throw new DatabaseContractError("Agent presence status is invalid");
    }
    addPresenceRow(byChannel, selectedSet, row);
  }
  // A resting Instance is offline but still the Channel's: the next message
  // wakes it (docs/instance-sleep.md §5). Newest first, a bounded few per
  // Channel; unlike live Instances, a Channel with more simply shows fewer.
  const resting = await transaction.query<ChannelAgentPresenceRow>({
    name: "channel_agent_resting_presence_v4",
    text: `SELECT * FROM (SELECT i.instance_id,i.channel_id,i.channel_instance_id,i.status,i.rest_state,i.rest_reason,
        i.created_at,i.updated_at,i.presentation_json->'usage' AS instance_usage,${DURABLE_PRESENTATION_SQL},
        r.workspace_machine_id,
        r.workspace_canonical_cwd,${PRESENCE_RUN_METADATA_SQL} AS run_metadata_json,
        COALESCE(s.display_name,r.metadata_json->>'agentName','Agent') AS agent_name,
        owner.email AS owner_email,
        b.owner_user_id AS registration_owner,b.machine_id AS registration_machine,b.harness AS registration_harness,
        (r.status='starting' OR EXISTS (SELECT 1 FROM data.agent_reborn_intents intent
          WHERE intent.source_instance_id=i.instance_id AND intent.state IN ('waiting','prepared'))) AS waking,
        row_number() OVER (PARTITION BY i.channel_id ORDER BY i.updated_at DESC,i.instance_id) AS rest_rank
      FROM data.instances i
      JOIN data.runs r ON r.run_id=i.run_id AND r.channel_id=i.channel_id
      JOIN data.run_agent_registrations b ON b.run_id=r.run_id AND b.space_id=$1
      LEFT JOIN data.space_agent_registrations s ON s.space_id=b.space_id AND s.owner_user_id=b.owner_user_id
        AND s.machine_id=b.machine_id AND s.harness=b.harness
      LEFT JOIN data.space_members owner ON owner.space_id=$1 AND owner.user_id=b.owner_user_id
      WHERE i.channel_id=ANY($2::text[]) AND i.status='offline'
        AND i.rest_state IN ('sleeping','interrupted','wake_failed')) resting
      WHERE resting.rest_rank<=$3
      ORDER BY resting.channel_id,resting.channel_instance_id,resting.instance_id
      LIMIT 2048`,
    values: [spaceId, selected, MAX_RESTING_INSTANCES_PER_CHANNEL],
    maxRows: MAX_RESTING_AGENT_INSTANCES,
  });
  for (const row of resting) {
    if (row.status !== "offline" || (row.rest_state !== "sleeping" && row.rest_state !== "interrupted" &&
        row.rest_state !== "wake_failed")) {
      throw new DatabaseContractError("Resting Agent presence state is invalid");
    }
    // A failed wake's successor never reached its daemon, so its Run may still
    // read `starting`; the failure, not that Run, is the Instance's state.
    addPresenceRow(byChannel, selectedSet, row,
      row.rest_state !== "wake_failed" && row.waking === true ? "waking" : row.rest_state);
  }
  return byChannel;
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
    name: "visible_live_agent_channels_v1",
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
            AND COALESCE(r.metadata_json->>'routedAs','')<>'management_channel_about'
        )
      ORDER BY c.channel_id
      LIMIT ${MAX_VISIBLE_LIVE_AGENT_CHANNELS}`,
    values: [spaceId, principal.kind, principal.id],
    maxRows: MAX_VISIBLE_LIVE_AGENT_CHANNELS,
  });
  return loadChannelAgentPresence(transaction, spaceId, channels.map((row) => row.channel_id));
}

/** Model, effort and chips stored on the Instance. A value this read cannot show is omitted. */
function durableInstancePresentation(row: ChannelAgentPresenceRow): Pick<
  SerializedAgentInstance, "model" | "effort" | "statusChips"
> {
  const model = boundedPresentationText(row.instance_model, 128);
  const effort = boundedPresentationText(row.instance_effort, 64);
  const statusChips = durableStatusChips(row.instance_status_chips);
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(statusChips ? { statusChips } : {}),
  };
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

/** One Instance's Presence entry. A Run's actor is its Instance, as in runtime
 * presence and message senders; a registration is launch configuration. */
function addPresenceRow(
  byChannel: Map<string, Record<string, ChannelMemberPresence>>,
  selected: ReadonlySet<string>,
  row: ChannelAgentPresenceRow,
  rest?: AgentInstanceRest,
): void {
  if (!selected.has(row.channel_id)) {
    throw new DatabaseContractError("Agent presence escaped its selected Channel scope");
  }
  const ordinal = Number(row.channel_instance_id);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new DatabaseContractError("Agent presence ordinal is invalid");
  }
  const runMetadata = row.run_metadata_json ?? {};
  // The xMatrix persona belongs to one management Run and is stamped on its
  // Instance label only; the member label stays the registration's name.
  const managementDelegate = runMetadata.routedAs === "management_assistant_mention";
  const instanceLabel = managementDelegate ? XMATRIX_MANAGEMENT_LABEL : row.agent_name;
  const label = row.agent_name;
  const avatarUrl = harnessAvatarUrl(row.registration_harness);
  const channelInstanceId = String(ordinal);
  const connectedAt = iso(row.created_at);
  const lastSeenAt = iso(row.updated_at);
  const instance: SerializedAgentInstance = {
    id: row.instance_id,
    channelInstanceId,
    channelId: row.channel_id,
    label: `${instanceLabel}:${channelInstanceId}`,
    connectedAt,
    lastSeenAt,
    status: row.status as SerializedAgentInstance["status"],
    ...(localLlmUsage(row.instance_usage ?? undefined) ? { usage: localLlmUsage(row.instance_usage ?? undefined) } : {}),
    ...(rest ? { rest } : {}),
    ...(rest === "wake_failed" && row.rest_reason ? { restReason: row.rest_reason } : {}),
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
    ...(metadataText(runMetadata, "gitBranch")
      ? { gitBranch: metadataText(runMetadata, "gitBranch") }
      : {}),
    ...durableInstancePresentation(row),
  };
  const channelPresence = byChannel.get(row.channel_id) ?? {};
  channelPresence[row.instance_id] = {
    kind: "agent",
    label,
    registration: { ownerUserId: row.registration_owner, machineId: row.registration_machine,
      harness: row.registration_harness },
    ...(row.owner_email ? { email: row.owner_email } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    lastSeenAt,
    usage: instance.usage,
    instances: [instance],
  };
  byChannel.set(row.channel_id, channelPresence);
}
