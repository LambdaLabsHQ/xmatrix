import type { AgentStatusChip } from "./agent-status-tags.js";
import type { AgentRegistrationKey } from "./agent-registration.js";
import type { ChannelMessage } from "./channel-message.js";
import type { ChannelSummarySource } from "./channel-summary.js";
import { DEFAULT_HUB_URL } from "./authority-foundation.js";
import type {
  AgentGoalStatus,
  AgentRuntimeState,
  AgentStatus,
  SerializedAgentInstance,
  WorkspaceRef,
} from "./authority-foundation.js";
import type {
  ChannelMode,
  SpaceManagementAgentConfig,
  SpaceRole,
} from "./authority-management.js";
import type {
  MachineRequestNoticeAcceptedMessage,
  MachineRequestNoticeMessage,
} from "./machine-request-review.js";

export interface SpaceMember {
  userId: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  handle?: string;
  bio?: string;
  /** IANA zone, so a reader can tell what hour of this member's day it is. */
  timeZone?: string;
  handleIsTemporary?: boolean;
  profileVersion?: number;
  role: SpaceRole;
  joinedAt: string;
}

export interface SerializedSpace {
  id: string;
  name: string;
  ownerId: string;
  members: SpaceMember[];
  /** Present only when the viewer may administer this Space. */
  pendingJoinRequestCount?: number;
  memberPermissions?: SpaceMemberPermissions;
  managementAgent?: SpaceManagementAgentConfig;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type SpaceMemberCreationPolicy = "members" | "admins";

export interface SpaceMemberPermissions {
  agentCreation: SpaceMemberCreationPolicy;
  automationCreation: SpaceMemberCreationPolicy;
}

export interface SerializedSpaceInvite {
  token: string;
  spaceId: string;
  spaceName: string;
  role: Exclude<SpaceRole, "owner">;
  createdBy?: string;
  createdAt: string;
  expiresAt?: string;
}

export type AppConnectorConnectionStatus = "configured" | "disconnected" | "error";

export type AppConnectorProviderId =
  | "github" | "webhook" | "sentry" | "linear" | "pagerduty" | "gitlab" | "slack" | "jira" | "vercel"
  | "cloudflare" | "feishu" | "discord" | "notion" | "bitbucket" | "circleci" | "buildkite" | "stripe" | "grafana"
  | "opsgenie" | "netlify" | "telegram" | "teams" | "googlechat" | "google" | "dingtalk" | "wecom" | "openconnector";
export type AppConnectorProviderKind =
  | "code-host" | "docs" | "webhook" | "observability" | "issue-tracker" | "incident" | "chat" | "deploy" | "ci"
  | "billing" | "gateway";
export type AppConnectorProviderStatus = "available" | "planned";

export type CommandCompletionDynamicSource =
  | "mention-targets"
  | "agent-references"
  | "agent-launch-targets"
  | "handoff-successor-profiles"
  | "agent-models"
  | "agent-efforts"
  | "connector-actions"
  | "github-organizations"
  | "github-repositories";

export type AppConnectorCompletionDynamicSource = Extract<
  CommandCompletionDynamicSource,
  "github-organizations" | "github-repositories"
>;

export type CommandCompletionDelimiter = "" | " " | ":" | "/";

export interface CommandCompletionArgumentSchema {
  id: string;
  label: string;
  source: AppConnectorCompletionDynamicSource;
  trailingDelimiter: CommandCompletionDelimiter;
  next?: CommandCompletionArgumentSchema;
}

export interface AppConnectorCompletionOption {
  id: string;
  value: string;
  label: string;
  description?: string;
}

export interface AppConnectorCompletionResponse {
  providerId: AppConnectorProviderId;
  source: AppConnectorCompletionDynamicSource;
  parent?: string;
  options: AppConnectorCompletionOption[];
}

export interface CommandCompletionSchemaNode {
  id: string;
  token: string;
  label: string;
  description?: string;
  action?: string;
  trailingDelimiter?: CommandCompletionDelimiter;
  next?: {
    delimiter: CommandCompletionDelimiter;
    source?: CommandCompletionDynamicSource;
    nodes?: CommandCompletionSchemaNode[];
    freeform?: boolean;
  };
}

export const MENTION_COMMAND_COMPLETION_SCHEMA: CommandCompletionSchemaNode = {
  id: "mention",
  token: "@",
  label: "Mention",
  next: {
    delimiter: "",
    source: "mention-targets",
  },
};

/** Instance command that transfers a live or dead source to a new successor. */
export const AGENT_HANDOFF_ACTION_COMPLETION_SCHEMA: CommandCompletionSchemaNode = {
  id: "agent-reference:handoff",
  token: "handoff",
  label: "Hand off checkout",
  description: "Transfer this instance's checkout to a new same-machine instance.",
  action: "handoff-instance",
  next: {
    delimiter: ":",
    source: "handoff-successor-profiles",
  },
};

export const AGENT_INSTANCE_COMMAND_COMPLETION_SCHEMA: CommandCompletionSchemaNode[] = [
  {
    id: "model",
    token: "/model",
    label: "Switch model",
    description: "Switch this live instance to another reported model.",
    action: "agent-model-switch",
    next: {
      delimiter: " ",
      source: "agent-models",
    },
  },
  {
    id: "effort",
    token: "/effort",
    label: "Switch effort",
    description: "Switch this live instance to another reported reasoning effort.",
    action: "agent-effort-switch",
    next: {
      delimiter: " ",
      source: "agent-efforts",
    },
  },
  {
    id: "goal",
    token: "/goal",
    label: "Goal",
    description: "Type a new goal or choose a goal control command.",
    action: "agent-goal-set",
    next: {
      delimiter: " ",
      freeform: true,
      nodes: [
        {
          id: "replace",
          token: "replace",
          label: "Replace goal",
          description: "Replace the current goal with a new objective.",
          action: "agent-goal-replace",
          trailingDelimiter: " ",
        },
        {
          id: "resume",
          token: "resume",
          label: "Resume goal",
          description: "Resume the current goal.",
          action: "agent-goal-resume",
          trailingDelimiter: " ",
        },
        {
          id: "pause",
          token: "pause",
          label: "Pause goal",
          description: "Pause the current goal.",
          action: "agent-goal-pause",
          trailingDelimiter: " ",
        },
        {
          id: "status",
          token: "status",
          label: "Goal status",
          description: "Show the current goal status.",
          action: "agent-goal-status",
          trailingDelimiter: " ",
        },
        {
          id: "clear",
          token: "clear",
          label: "Clear goal",
          description: "Clear the current goal.",
          action: "agent-goal-clear",
          trailingDelimiter: " ",
        },
      ],
    },
  },
];

export interface SerializedAppConnectorConnection {
  id: string;
  spaceId: string;
  providerId: string;
  providerName: string;
  status: AppConnectorConnectionStatus;
  authMode: "oauth" | "api-token";
  scopes: string[];
  secretRefs: string[];
  capabilities: string[];
  /** Retired. Always empty. Connector actions follow the Space connection, not a channel allowlist. */
  channelIds: string[];
  /** Names of the values in the connection's encrypted credential store; never the values. */
  credentialFields?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  /** Channel-scoped routing and source subscriptions, returned only when a
   * concrete accessible channel is requested. */
  channelState?: SerializedAppConnectorChannelState;
}

export interface SerializedAppConnectorChannelSubscription {
  kind: "repository" | "issue";
  source: string;
  features: string[];
  updatedAt: string;
}

export interface SerializedAppConnectorChannelState {
  channelId: string;
  /** Retired. Always true when the Space connection is configured. */
  enabled: boolean;
  /** Whether this channel has an active direct subscription for the Space connection. */
  bound: boolean;
  subscriptions: SerializedAppConnectorChannelSubscription[];
}

export interface UpsertAppConnectorConnectionRequest {
  providerId: string;
  providerName?: string;
  status?: AppConnectorConnectionStatus;
  authMode?: "oauth" | "api-token";
  scopes?: string[];
  secretRefs?: string[];
  capabilities?: string[];
  agentId?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type AppConnectorExecutionStatus = "queued" | "completed" | "failed" | "blocked" | "planned";

export interface SerializedAppConnectorExecution {
  id: string;
  spaceId: string;
  channelId: string;
  messageId: string;
  providerId: string;
  providerName: string;
  actionId?: string;
  actionLabel?: string;
  status: AppConnectorExecutionStatus;
  reason?: string;
  connectionId?: string;
  resultChannelId?: string;
  resultSummary?: string;
  requestedBy: string;
  requestedByLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedChannel {
  id: string;
  spaceId: string;
  name?: string;
  topic?: string;
  summary?: string;
  /** Who wrote `summary`, when, and how far into the conversation it reaches. */
  summarySource?: ChannelSummarySource;
  mode: ChannelMode;
  /** Legacy UI count/sequence estimate. Not a Local Replica consistency proof. */
  messageCount?: number;
  /**
   * Authoritative committed message-sequence watermark for this Channel.
   * Recalls, deletes, and archival do not decrement it. Clients may prove
   * Local Replica freshness against this monotonic value, but must treat an
   * omitted value as unknown rather than zero.
   */
  historyHeadSequence?: number;
  /**
   * Validation watermark for client history caches. `contentRevision` moves
   * exactly when the bytes of already-served history can change (edit, recall,
   * redaction, archive drain) and never on append; `protocolVersion` covers
   * byte-affecting schema migrations that bypass the counter. Treat an omitted
   * field (older Hub) as no signal, never as revision 0.
   */
  contentAuthority?: { protocolVersion: number; contentRevision: number };
  /** Scope key used to look up this Channel in projectionCacheManifest. */
  projectionCacheScopeId?: string;
  /**
   * Highest message sequence read by the currently authenticated human.
   * Hydrated only on user-scoped channel list/read responses and pushes.
   */
  readSequence?: number;
  /**
   * Highest message sequence each Channel member has read, keyed by the
   * durable subject identity (`user:<userId>` / `agent:<instanceId>`).
   * This is the same delivery cursor `readSequence` reports for the caller,
   * projected for every member so mention read state can be shown at the `@`.
   * Visible only to members of the Channel. An absent field means the payload
   * cannot report member read state at all (clients must render "unknown"); a
   * present field with a missing subject means that member has read nothing in
   * this Channel.
   */
  memberReadSequences?: Record<string, number>;
  /* tail-message preview for chat-list UIs (same shape as reply contexts);
     hydrated on channel LIST responses only — single-channel payloads may
     omit it, so clients must merge-preserve */
  lastMessage?: ChannelReplyContext;
  attention?: ChannelAttentionSummary;
  /**
   * Stable Human member identities authorized to read a closed Channel.
   * Open Channels inherit `SerializedSpace.members` and omit this projection.
   * Values use the channel identity form `user:<userId>`; live presence is
   * reported separately in `memberPresence`.
   */
  visibleHumanMemberIds?: string[];
  memberPresence?: Record<string, ChannelMemberPresence>;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdByAgent?: SerializedChannelCreatorAgent;
  createdAt: string;
  updatedAt: string;
}

/**
 * Opaque cursor for one authenticated cross-Space Channel catalog snapshot.
 * `complete=false` means the response replaces only `replacedSpaceIds` and
 * removes `removedSpaceIds`; every other Space remains covered by the prior
 * complete snapshot named by the request token.
 */
export interface ChannelCatalogSyncMetadata {
  protocolVersion: 1;
  token: string;
  complete: boolean;
  replacedSpaceIds: string[];
  removedSpaceIds: string[];
}

export type ChannelCatalogPageView = "flat" | "search" | "intake";
/** `mentions` was retired with the Mentions pane; unread still covers attention. */
export type ChannelCatalogPageFilter = "all" | "unread";

export interface ChannelCatalogPageRow {
  channel: SerializedChannel;
  ownActivityAt: string;
}

export interface ChannelCatalogPageCounts {
  active: number;
  unread: number;
  mentions: number;
}

export interface ChannelCatalogPage {
  protocolVersion: 1;
  catalogRevision: number;
  rows: ChannelCatalogPageRow[];
  /** Opaque, query-bound continuation token. */
  nextCursor: string | null;
  /** Deferred on the first-page request so aggregate work cannot delay rows. */
  counts: ChannelCatalogPageCounts | null;
}

export interface ChannelCatalogResolveResult {
  protocolVersion: 1;
  channels: SerializedChannel[];
  /** Authorized root-to-target paths. Unavailable targets are omitted. */
  pathsByChannelId: Record<string, string[]>;
  /** Authorized root-to-target paths selected by an opaque public route token. */
  pathsByRouteToken?: Record<string, string[]>;
}

export type {
  ChannelProjectionCacheAuthority,
  ChannelProjectionCacheManifest,
  ChannelProjectionCacheScope
} from "./channel-projection-cache";

export interface SerializedChannelCreatorAgent {
  identityId: string;
  agentName: string;
  userId: string;
  email: string;
  instanceId?: string;
}

export type ChannelAttentionTriggerKind = "mention" | "reply" | "quote" | "broadcast";
export type ChannelAttentionTargetKind = "user" | "agent_instance" | "broadcast";
export type ChannelAttentionBroadcastScope = "channel" | "everyone" | `role:${string}`;

export interface ChannelAttentionSummary {
  channelId: string;
  unreadAttentionCount: number;
  lastAttentionAt?: string;
  lastMessageId?: string;
  lastMessageSequence?: number;
  primaryTriggerKind?: ChannelAttentionTriggerKind;
  triggerKinds?: ChannelAttentionTriggerKind[];
  targetKind?: ChannelAttentionTargetKind;
  broadcastScope?: ChannelAttentionBroadcastScope;
  updatedAt: string;
}

export type ChannelMessageNotificationReason = "mention" | "reply" | "broadcast";

/** Per-recipient metadata. The server constructs this independently for each Human session. */
export interface ChannelMessageNotification {
  reason: ChannelMessageNotificationReason;
  /** Direct-message notifications intentionally do not create an attention badge. */
  attention?: ChannelAttentionSummary;
}

export interface ChannelAttentionSnapshotSpace {
  spaceId: string;
  /** False means the client must retain its prior local slice for this Space. */
  complete: boolean;
  summaries: ChannelAttentionSummary[];
}

/** Rebuildable viewer-specific state, deliberately independent of catalog revision tokens. */
export interface ChannelAttentionSnapshot {
  protocolVersion: 1;
  spaces: ChannelAttentionSnapshotSpace[];
}

interface ChannelMemberPresenceBase {
  label?: string;
  email?: string;
  avatarUrl?: string;
  lastSeenAt?: string;
  activity?: string;
  files?: string[];
  intent?: string;
  runtimeState?: AgentRuntimeState;
  goal?: AgentGoalStatus;
  usage?: LlmUsage;
  instances?: SerializedAgentInstance[];
}

export interface ChannelHumanMemberPresence extends ChannelMemberPresenceBase {
  kind: "user";
  status: AgentStatus;
  /** True when at least one live client for this human is currently showing this channel. */
  focused?: boolean;
}

/**
 * A stable Agent identity has no aggregate runtime status. Live status belongs
 * exclusively to each entry in `instances`.
 */
export interface ChannelAgentMemberPresence extends ChannelMemberPresenceBase {
  kind: "agent";
  /**
   * The Space Agent Registration this member's Run executes under. It is the
   * member's only identity: clients read owner, machine and harness here and
   * never join a member to any other Agent record.
   */
  registration?: AgentRegistrationKey;
}

export type ChannelMemberPresence =
  | ChannelHumanMemberPresence
  | ChannelAgentMemberPresence;

export type { ChannelMessage };

export type ChannelMentionReadTargetKind = "user" | "agent_instance" | "app";
export type ChannelMentionReadState = "read" | "unread" | "unknown";

export interface ChannelMentionReadStatus {
  targetId: string;
  targetKind: ChannelMentionReadTargetKind;
  label: string;
  status: ChannelMentionReadState;
  readAt?: string;
  readSequence?: number;
}

export interface ChannelAppMention {
  token: string;
  appId: string;
  appName: string;
  status: "available" | "planned";
  actionId?: string;
  actionLabel?: string;
}

export interface ChannelReplyContext {
  messageId: string;
  from: MessageSender;
  bodyPreview: string;
  sentAt: string;
  recalledAt?: string;
  /**
   * Per-channel sequence of the quoted message. A reader that jumps to the
   * quote needs one keyset seek instead of paging the whole history back to
   * it, so the preview carries the target's own coordinate. Optional for the
   * same reason `ChannelMessage.sequence` is: older persisted messages and
   * client-built previews may not have one.
   */
  sequence?: number;
}

export interface ChannelReaction {
  emoji: string;
  reactors: ChannelReactionActor[];
}

export interface ChannelReactionActor {
  identityId: string;
  label: string;
}

export interface ChannelAttachment {
  id: string;
  kind: "image" | "video" | "markdown" | "file";
  name: string;
  mimeType: string;
  size: number;
  /**
   * Stable owner binding for authenticated lazy media retrieval.
   * These are record identities only; clients must never derive an object
   * locator or authorization decision from them.
   */
  channelId?: string;
  messageId?: string;
  dataUrl?: string;
  url?: string;
  objectKey?: string;
  /** Relay V2 immutable object digest. Present on replica-backed attachments. */
  contentHash?: string;
  /** Relay V2 attachment entity version. */
  version?: number;
  thumbnailUrl?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  /** Open presentation state; clients must tolerate future server-defined values. */
  transcodingStatus?: string;
}

// ── memory-fabric: generic channel annotations ───────────────────────────
//
// Annotations are external records pointing at a target inside a channel.
// They are namespace-scoped; Hub stores/serves/queries but never parses
// payload. Memory ("xmem.canonical.v1" / "xmem.candidate.v1") is one
// namespace family among many.

/**
 * Open annotation target discriminator. Hub validates the structural fields
 * of channel/message/message_range, while future kinds remain inert data and
 * do not require a protocol or SQL enum migration.
 */
export type AnnotationTargetKind = string;

export interface AnnotationTarget {
  kind: AnnotationTargetKind;
  /** Required for kind="message": the targeted message id. */
  messageId?: string;
  /** Required for kind="message_range": inclusive start sequence. */
  startSequence?: number;
  /** Required for kind="message_range": inclusive end sequence. */
  endSequence?: number;
}

export interface MessageSender {
  /** Agent registration captured by the Hub from the authorized Run binding.
   * Optional for historical messages; independent of live Channel presence. */
  registration?: AgentRegistrationKey;
  /**
   * Stable actor identity for authorship, cursors, and reactions.
   * Humans use `user:<userId>`; agents use their `SerializedAgent.id`; apps use
   * `app:<providerId>`; xMatrix itself uses `system:xmatrix`.
   */
  identityId?: string;
  kind: "user" | "agent" | "app" | "system";
  label: string;
  /**
   * Owning account for authorization and workspace lookup. Kept as `userId`
   * for backward compatibility with older clients.
   */
  userId: string;
  email: string;
  agentName?: string;
  /**
   * Live agent instance that authored the message. This is the globally unique
   * instance id, not the channel mention ordinal.
   *
   * Required of every agent sender: the hub refuses to commit an agent message
   * that cannot name its exact live instance, so a reader asking "did I write
   * this?" answers on this field. Absent on user and app senders, and on agent
   * messages committed before the rule; those are history, not a shape to
   * reproduce.
   */
  instanceId?: string;
  /**
   * Per-channel ordinal captured for display and `@agent:<n>` addressing only.
   */
  channelInstanceId?: string;
  /**
   * Human-readable per-agent instance label captured when the message is sent.
   */
  instanceLabel?: string;
  /**
   * Set only when an Agent Run wrote outside its own Channel (a cross-Channel
   * link): the Channel the Run belongs to, where `channelInstanceId` and
   * `instanceLabel` are meaningful. Stamped by the Hub from the Run's own
   * records, never by the caller.
   */
  originChannelId?: string;
  /**
   * The message in `originChannelId` the Run was handling when it wrote the
   * link. Absent when the Run was between turns.
   */
  originMessageId?: string;
  /**
   * Agent goal captured when the message is sent. This is a sender snapshot so
   * historical chat headers do not depend on live presence still being online.
   */
  goal?: AgentGoalStatus;
  /**
   * Git branch captured when the message is sent. This is a sender snapshot so
   * historical chat headers do not depend on live presence still being online.
   */
  gitBranch?: string;
  /**
   * LLM model captured when the message is sent. This is a sender snapshot so
   * historical chat headers do not depend on live presence still being online.
   */
  model?: string;
  /**
   * Reasoning effort captured when the message is sent. This is a sender
   * snapshot so historical chat headers do not depend on live presence.
   */
  effort?: string;
  /**
   * Dynamic status chips captured when the message is sent. Preferred over
   * fixed model/effort fields for multi-vendor status display.
   */
  statusChips?: AgentStatusChip[];
  workspace?: WorkspaceRef;
  workspaceName?: string;
  avatarUrl?: string;
}

// --- Event Stream ---

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
  contextUsagePercent?: number;
  /** Account quota is displayable only when read from the provider API. */
  quotaSource?: "provider_api";
  /** Server projection: unknown withdraws an expired reading; exhausted identifies a hold without named windows. */
  quotaState?: "observed" | "unknown" | "exhausted";
  /** Actual provider read time; retransmission must preserve it. */
  quotaObservedAt?: string;
  quotaUsages?: LlmQuotaUsage[];
  /** Read with `quotaUsages`: whether the provider still serves the account. */
  quotaAccount?: LlmQuotaAccount;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningTokens?: number;
  toolCallCount?: number;
  costUsd?: number;
}

/** Instance counters without any shared-account projection or observation. */
export function localLlmUsage(usage: LlmUsage | undefined): LlmUsage | undefined {
  const { quotaSource: _source, quotaState: _state, quotaObservedAt: _at, quotaUsages: _windows,
    quotaAccount: _account, ...local } = usage ?? {};
  return Object.keys(local).length ? local : undefined;
}

/** A provider read time small enough to store and parse. Anything else is not a reading. */
export function parseQuotaObservedAt(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

export interface LlmQuotaUsage {
  label?: string;
  window?: string;
  used?: number;
  limit?: number;
  remaining?: number;
  /**
   * Share of the window consumed, 0-100. Runtimes settle the scale where they
   * still know the provider; readers take it as-is. Rescaling it downstream
   * turned a reported 1% into 100% and marked idle agents as out of quota.
   */
  percent?: number;
  resetAt?: string;
}

/**
 * Whether the provider still serves the account, as it said in the same read
 * as the windows. `allowed` is the provider's verdict: a used-up window does
 * not stop an account it keeps serving on credits, and a refusal stops one
 * whose windows look fine. Whether to spend credits is the account's setting.
 */
export interface LlmQuotaAccount {
  allowed?: boolean;
  credits?: { balance?: number; unlimited?: boolean };
}

/** The account state a provider read carried, or none. Unknown keys are dropped. */
export function parseLlmQuotaAccount(value: unknown): LlmQuotaAccount | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const credits = row.credits && typeof row.credits === "object" && !Array.isArray(row.credits)
    ? row.credits as Record<string, unknown> : undefined;
  const balance = typeof credits?.balance === "number" && Number.isFinite(credits.balance) && credits.balance >= 0
    ? credits.balance : undefined;
  const account: LlmQuotaAccount = {
    ...(typeof row.allowed === "boolean" ? { allowed: row.allowed } : {}),
    ...(credits ? { credits: { ...(balance !== undefined ? { balance } : {}),
      ...(credits.unlimited === true ? { unlimited: true } : {}) } } : {}),
  };
  return Object.keys(account).length ? account : undefined;
}

// --- Agent Skills ---

export type AgentSkill = "spec" | "plan" | "build" | "test" | "review" | "ship";

export function normalizeHubUrl(input?: string | null): string {
  const value = (input || DEFAULT_HUB_URL).trim().replace(/\/+$/, "");
  if (value.startsWith("ws://")) {
    return `http://${value.slice("ws://".length)}`.replace(/\/ws$/, "");
  }

  if (value.startsWith("wss://")) {
    return `https://${value.slice("wss://".length)}`.replace(/\/ws$/, "");
  }

  return value.replace(/\/ws$/, "");
}

function deriveConnectionUrl(hubUrl: string, pathname: string): string {
  const normalizedHubUrl = normalizeHubUrl(hubUrl);
  const url = new URL(normalizedHubUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function deriveHumanConnectionUrl(hubUrl: string): string {
  return deriveConnectionUrl(hubUrl, "/ws/humans");
}

export function withRoute(baseUrl: string, route: string): string {
  return new URL(route, `${normalizeHubUrl(baseUrl)}/`).toString();
}

// --- Observability Events ---

export type ObservabilityEventType =
  | "agent_connected"
  | "agent_renamed"
  | "agent_disconnected"
  | "agent_spawn_started"
  | "agent_spawn_auth_required"
  | "agent_spawn_finished"
  | "agent_stop_finished"
  | "message_routed"
  | "channel_created"
  | "channel_joined"
  | "channel_left"
  | "channel_archived"
  | "channel_delete_approval_requested"
  | "channel_deleted"
  | "channel_resumed"
  | "channel_message_routed"
  | "channel_mention"
  | "channel_attention_updated"
  | "channel_member_read_updated"
  | "channel_history_loaded"
  | "channel_history_replayed"
  | "client_network_sample"
  | "channel_topic_updated"
  | "channel_worktree_isolation_updated"
  | "channel_worktree_cleanup_finished"
  | "daemon_request_resolved"
  | "broadcast_sent"
  | "presence_updated"
  | "rate_limit_hit"
  | "space_created"
  | "space_updated"
  | "space_deleted"
  | "space_member_updated"
  | "space_claim_acquired"
  | "space_claim_renewed"
  | "space_claim_released"
  | "space_claim_expired"
  | "space_management_action_executed"
  | "workspace_updated"
  | "automation_created"
  | "automation_updated"
  | "automation_deleted"
  | "automation_run_started"
  | "automation_run_failed"
  | "daemon_connected"
  | "daemon_disconnected"
  | "daemon_health_updated"
  | "connector_subscription_updated"
  | "connector_delivery_finished"
  | "connector_github_issue"
  | "connector_github_pull_request"
  | "connector_github_review"
  | "connector_github_check"
  | "connector_github_commit"
  | "connector_github_deployment"
  | "connector_github_release"
  | "connector_credential_failed"
  | "connector_action_finished"
  | "management_fuse_updated"
  | "security_policy_updated"
  | "agent_goal_updated"
  | "agent_tool_failed"
  | "agent_waiting"
  | "agent_human_input_required"
  | "quota_updated"
  | "cost_budget_updated"
  | "rpc_request_sent"
  | "rpc_response_sent"
  | "event_published"
  | "event_subscribed"
  | "change_feed_published"
  | "intent_declared"
  | "context_translated"
  | "encrypted_envelope_routed"
  | "acl_updated"
  | "acl_denied"
  | "kv_operation"
  | "skills_advertised";

export type TraceAccessDuration = "permanent" | "channel" | "once";

export type TraceAccessStatus =
  | "pending"
  | "approved"
  | "denied"
  | "revoked"
  | "expired";

/**
 * A viewer's access to another user's agent trajectories (llm_trace events).
 * Requested by the viewer, decided by the agent's owner. "once" grants are
 * bound to a single agent instance and expire with it (bounded by a TTL);
 * "channel" grants cover the agent's instances in one channel for a bounded
 * period; "permanent" grants last until the owner revokes them.
 */
export interface TraceAccessGrant {
  id: string;
  ownerUserId: string;
  ownerLabel?: string;
  viewerUserId: string;
  viewerLabel?: string;
  agentId: string;
  agentName?: string;
  instanceId?: string;
  channelId?: string;
  duration: TraceAccessDuration;
  status: TraceAccessStatus;
  reason?: string;
  requestedAt: string;
  decidedAt?: string;
  expiresAt?: string;
  /** Monotonic Authority metadata version. Legacy grants may omit it. */
  version?: number;
}

export interface ObservabilityEvent {
  id: string;
  type: ObservabilityEventType;
  workspaceUserId: string;
  agentId?: string;
  agentName?: string;
  targetAgentId?: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/** Availability of an exact Agent host session's process-local trace. */
export type TraceInstanceHistoryAvailability = "available" | "unavailable" | "expired";

export type ClientNetworkSampleKind = "web" | "ios" | "cli";
export type ClientNetworkSampleMode =
  | "initial"
  | "refresh"
  | "reconnect"
  | "send";
export type ClientNetworkState =
  | "online"
  | "reconnecting"
  | "offline"
  | "unknown";
export type ClientNetworkSampleResult = "success" | "failed" | "timeout";

export interface ClientNetworkSample {
  clientKind: ClientNetworkSampleKind;
  mode: ClientNetworkSampleMode;
  networkState: ClientNetworkState;
  result: ClientNetworkSampleResult;
  channelId: string;
  latencyMs?: number;
  entryCount?: number;
  truncated?: boolean;
  afterSequence?: number;
  lastSequence?: number;
  reconnectAttempt?: number;
  lastServerActivityAgeMs?: number;
  reason?: string;
}

// --- Team Management ---

// --- Eval Runtime ---

export type EvalLanguage = "typescript";
export type EvalExpressionKind = "text" | "expression" | "event" | "library-export";

export interface EvalExpression {
  kind: EvalExpressionKind;
  ref: string;
  language?: EvalLanguage | "natural-language" | "json";
  text?: string;
  libraryRef?: string;
  exportName?: string;
}

export type {
  MachineRequestNoticeAcceptedMessage,
  MachineRequestNoticeMessage
};
