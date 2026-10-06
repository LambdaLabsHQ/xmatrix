import { isPlainRecord as isRecord } from "../plain-record.js";
import { utf8ByteLength } from "../hex.js";
import type {
  AgentLifecycleLayer,
  AgentLifecycleReason,
  AgentLifecycleSnapshot,
  AgentLifecycleStatus,
  AuthUser,
  ChannelMessage,
  MessageSender,
  ObservabilityEvent,
  SerializedAgent,
  SerializedChannel,
  SerializedSpace,
  TraceAccessGrant,
} from "../authority.js";
import { rfc3339TimestampEpochNanoseconds } from "../timestamp.js";

/**
 * The Hub refused a `human_connect` credential (expired, invalid, or not a
 * Human's). It answers with this failure code and closes the socket with
 * `HUMAN_AUTH_REQUIRED_CLOSE_CODE`; dialling again with the same token is
 * refused again, so a client renews its session first.
 */
export const HUMAN_AUTH_INVALID_FAILURE_CODE = "human_auth_invalid";
export const HUMAN_AUTH_REQUIRED_CLOSE_CODE = 4401;

/** First message accepted by the Human connection endpoint. */
export interface HumanConnectMessage {
  type: "human_connect";
  requestId?: string;
  token: string;
  device?: {
    client?: string;
    label?: string;
    platform?: string;
    version?: string;
    protocolVersion?: number;
    /**
     * Optional behaviours this client handles. `presence_digest`: Agent
     * presence for conversations it is not showing may arrive batched in one
     * `presence_digest` frame per second instead of one frame per change.
     */
    capabilities?: string[];
  };
}

export const HUMAN_CLIENT_PRESENCE_DIGEST = "presence_digest";

/**
 * Agent presence for conversations this socket is not showing, batched: the
 * latest card per Agent and Instance set since the previous digest. Each card
 * means exactly what an `enhanced_presence` frame with it would.
 */
export type HumanPresenceDigestMessage = {
  type: "presence_digest";
  agents: SerializedAgent[];
};

export interface HumanFocusChannelMessage {
  type: "user_focus_channel";
  requestId?: string;
  /** The channel currently shown by this Human client, or null when none is shown. */
  channelId: string | null;
  /** Optional bounded online tail returned on the already-authenticated socket. */
  historyLimit?: number;
}

export type HumanClientMessage =
  | HumanConnectMessage
  | HumanFocusChannelMessage
  | { type: "ping"; requestId?: string };

/**
 * "This Space's Channel catalog changed — re-read stale indexes."
 *
 * The frame intentionally carries no Channel facts. Catalog reads remain the
 * only ACL-enforcing source of rows; this monotonic watermark merely makes
 * inactive indexes (notably Flat and collapsed child pages) converge promptly.
 */
export type HumanChannelCatalogChangedMessage = {
  type: "space_channel_catalog_changed";
  spaceId: string;
  revision: number;
};

export type HumanTraceAccessServerMessage =
  | { type: "trace_access_requested"; grant: TraceAccessGrant }
  | { type: "trace_access_updated"; grant: TraceAccessGrant };

export type HumanServerMessage =
  | { type: "error"; requestId?: string; message: string; failure?: import("../runtime-operation-failure.js").RuntimeOperationFailure }
  | { type: "pong"; requestId?: string; ts: string }
  | { type: "auth_refreshed"; requestId?: string; ts: string }
  | { type: "user_subscribed"; requestId?: string; user: AuthUser }
  | { type: "human_connected"; requestId?: string; user: AuthUser }
  | { type: "unregistered"; requestId?: string }
  | { type: "shutdown_requested"; reason?: string }
  | { type: "agent_list"; requestId?: string; agents: SerializedAgent[] }
  | { type: "presence"; online: boolean; agent: SerializedAgent }
  | { type: "enhanced_presence"; agent: SerializedAgent }
  | HumanPresenceDigestMessage
  | {
      type: "agent_lifecycle";
      ts: string;
      status: AgentLifecycleStatus;
      layer: AgentLifecycleLayer;
      agentName: string;
      agentId: string;
      channelId?: string;
      channelInstanceId?: string;
      instanceId?: string;
      reason?: AgentLifecycleReason;
      snapshot?: AgentLifecycleSnapshot;
      detail?: string;
    }
  | { type: "space_created"; requestId?: string; space: SerializedSpace }
  | { type: "space_updated"; requestId?: string; space: SerializedSpace }
  | { type: "space_deleted"; requestId?: string; spaceId: string }
  | { type: "space_member_upserted"; requestId?: string; space: SerializedSpace }
  | { type: "space_member_removed"; requestId?: string; space: SerializedSpace }
  | HumanChannelCatalogChangedMessage
  | { type: "channel_created"; requestId?: string; channel: SerializedChannel }
  | { type: "channel_updated"; requestId?: string; channel: SerializedChannel }
  | { type: "channel_deleted"; requestId?: string; channelId: string }
  | {
      type: "app_connector_result_channels";
      sourceChannelId: string;
      sourceMessageId: string;
      channels: SerializedChannel[];
    }
  | { type: "channel_list"; requestId?: string; channels: SerializedChannel[] }
  | {
      type: "channel_topic_updated";
      requestId?: string;
      channelId: string;
      topic: string;
      updatedBy: MessageSender;
      updatedAt: string;
    }
  | { type: "observable_event"; event: ObservabilityEvent }
  | HumanTraceAccessServerMessage
  | {
      type: "channel_message_received";
      message: ChannelMessage;
      /** Correlates the live frame with the sender's optimistic row. */
      clientMessageId?: string;
      /** Present only when this exact Human recipient should raise a native notification. */
      notification?: import("../authority-runtime.js").ChannelMessageNotification;
    }
  | {
      type: "channel_message_updated";
      channelId: string;
      message: ChannelMessage;
    }
  | {
      type: "channel_history";
      requestId?: string;
      channelId: string;
      messages: ChannelMessage[];
      hasMore: boolean;
    };

/** Strictly decode Authority-authored trace access invalidations on the Human socket. */
export function parseHumanTraceAccessServerMessage(
  value: unknown,
): HumanTraceAccessServerMessage | undefined {
  if (!isRecord(value) ||
      (value.type !== "trace_access_requested" && value.type !== "trace_access_updated") ||
      !hasExactKeys(value, ["type", "grant"])) {
    return undefined;
  }
  const grant = parseTraceAccessGrant(value.grant);
  if (!grant) return undefined;
  const statusAllowed = value.type === "trace_access_requested"
    ? grant.status === "pending"
    : grant.status === "approved" || grant.status === "denied" ||
      grant.status === "revoked" || grant.status === "expired";
  return statusAllowed ? { type: value.type, grant } : undefined;
}

export function parseHumanChannelCatalogChangedMessage(
  value: unknown,
): HumanChannelCatalogChangedMessage | undefined {
  if (!isRecord(value) ||
      value.type !== "space_channel_catalog_changed" ||
      !hasExactKeys(value, ["type", "spaceId", "revision"]) ||
      typeof value.spaceId !== "string" || value.spaceId.length === 0 ||
      value.spaceId.length > 200 ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    return undefined;
  }
  return {
    type: "space_channel_catalog_changed",
    spaceId: value.spaceId,
    revision: value.revision as number,
  };
}

/** Strict decoder shared by Human WebSocket and trace-access REST responses. */
export function parseTraceAccessGrant(value: unknown): TraceAccessGrant | undefined {
  if (!isRecord(value)) return undefined;
  const grant = value;
  if (!hasOnlyKeys(grant, [
    "id", "ownerUserId", "ownerLabel", "viewerUserId", "viewerLabel",
    "agentId", "agentName", "instanceId", "channelId", "duration", "status",
    "reason", "requestedAt", "decidedAt", "expiresAt", "version",
  ])) return undefined;
  if (!boundedTraceString(grant.id, 200) ||
      !boundedTraceString(grant.ownerUserId, 200) ||
      !boundedTraceString(grant.viewerUserId, 200) ||
      grant.ownerUserId === grant.viewerUserId ||
      !boundedTraceString(grant.agentId, 200) ||
      rfc3339TimestampEpochNanoseconds(grant.requestedAt) === undefined ||
      !Number.isSafeInteger(grant.version) || Number(grant.version) < 1) {
    return undefined;
  }
  for (const [field, limit] of [
    // The legacy RelayRoom writer bounded these display strings by JavaScript
    // code units. The compatibility wire keeps a deterministic UTF-8 ceiling
    // at the corresponding worst case so multilingual persisted values do not
    // become undecodable during migration. New Authority writers are byte-bounded
    // more tightly.
    ["ownerLabel", 800], ["viewerLabel", 800], ["agentName", 800],
    ["instanceId", 200], ["channelId", 180], ["reason", 2_000],
  ] as const) {
    if (field in grant && !boundedTraceString(grant[field], limit)) return undefined;
  }
  for (const field of ["decidedAt", "expiresAt"] as const) {
    if (field in grant && rfc3339TimestampEpochNanoseconds(grant[field]) === undefined) return undefined;
  }
  if (grant.duration !== "permanent" && grant.duration !== "channel" &&
      grant.duration !== "once") return undefined;
  if (grant.status !== "pending" && grant.status !== "approved" &&
      grant.status !== "denied" && grant.status !== "revoked" &&
      grant.status !== "expired") return undefined;

  // Historical rows can be incomplete even while retaining their original
  // pending/approved status. Decode them as audit facts; every authorization
  // path separately requires the complete duration-specific scope and TTL.
  // A historical permanent grant may carry a restrictive expiry. Authority and
  // every client treat that bound exactly like any other grant expiry; dropping
  // it would broaden authority.
  if (grant.status === "pending") {
    if ("decidedAt" in grant) return undefined;
  } else if (grant.status !== "expired" && !("decidedAt" in grant)) {
    return undefined;
  }

  const requestedAt = rfc3339TimestampEpochNanoseconds(grant.requestedAt)!;
  const expiresAt = "expiresAt" in grant ? rfc3339TimestampEpochNanoseconds(grant.expiresAt)! : undefined;
  const decidedAt = "decidedAt" in grant ? rfc3339TimestampEpochNanoseconds(grant.decidedAt)! : undefined;
  if (expiresAt !== undefined &&
      (expiresAt < requestedAt || (expiresAt === requestedAt && grant.status !== "expired"))) {
    return undefined;
  }
  if (decidedAt !== undefined && decidedAt < requestedAt) return undefined;
  if (grant.status !== "expired" && expiresAt !== undefined &&
      decidedAt !== undefined && decidedAt >= expiresAt) {
    return undefined;
  }
  return grant as unknown as TraceAccessGrant;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && hasOnlyKeys(value, expected);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function boundedTraceString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    utf8ByteLength(value) <= maxBytes;
}
