import type {
  AgentGoalStatus,
  AgentLifecycleLayer,
  AgentLifecycleReason,
  AgentLifecycleSnapshot,
  AgentLifecycleStatus,
  AgentPresentationSnapshot,
  AgentRuntimeState,
  ChannelAppMention,
  ChannelMessage,
  ClientNetworkSample,
  LiveAgentStatus,
  ObservabilityEvent,
  SerializedAgent,
  TraceInstanceHistoryAvailability,
} from "../authority.js";
import type { ChannelActivity } from "../channel-activity.js";

/**
 * First message accepted by the Agent Instance connection endpoint.
 *
 * This describes one running process. It never creates or mutates an Agent
 * registration and carries no Space, Role-assignment, or machine-control authority.
 */
export interface AgentInstanceConnectMessage {
  type: "agent_instance_connect";
  requestId?: string;
  token: string;
  identityId?: string;
  name: string;
  runtime: {
    kind: string;
    clientVersion?: string;
    protocolVersion?: number;
    capabilities?: string[];
  };
  runContext?: Record<string, unknown>;
}

export interface AgentInstanceJoinChannelMessage {
  type: "join_channel";
  requestId?: string;
  channelId: string;
  historyLimit: number;
  /** Reconnect waterline; Hub replays messages with a greater sequence. */
  afterSequence?: number;
}

export interface AgentInstanceReplayChannelHistoryMessage {
  type: "replay_channel_history";
  requestId?: string;
  channelId: string;
  historyLimit: number;
  /** Reconnect waterline; Hub replays messages with a greater sequence. */
  afterSequence?: number;
}

export interface AgentInstanceLeaveChannelMessage {
  type: "leave_channel";
  requestId?: string;
  channelId: string;
}

export interface AgentInstanceChannelMessage {
  type: "channel_message";
  requestId?: string;
  channelId: string;
  body: string;
  replyToMessageId?: string;
  appMentions?: ChannelAppMention[];
  metadata?: Record<string, unknown>;
}

/**
 * A fact the Run's runtime observed about its own work (docs/design/
 * conversation-activity.md §3.2). The Hub validates it, writes the entry's body
 * and metadata itself, and delivers it as context only.
 */
export interface AgentInstanceChannelActivityMessage {
  type: "channel_activity";
  requestId?: string;
  channelId: string;
  activity: ChannelActivity;
}

export interface AgentInstanceChannelMessageAck {
  type: "channel_message_ack";
  messageId: string;
  channelId: string;
  sequence?: number;
}

export interface AgentInstanceGetChannelHistoryMessage {
  type: "get_channel_history";
  requestId?: string;
  channelId: string;
  limit?: number;
  before?: string;
  beforeSequence?: number;
  afterSequence?: number;
}

export interface AgentInstancePresenceUpdateMessage extends AgentPresentationSnapshot {
  type: "presence_update";
  requestId?: string;
  status?: LiveAgentStatus;
  activity?: string;
  files?: string[];
  intent?: string;
  gitBranch?: string;
  capabilities?: string[];
  runtimeState?: AgentRuntimeState;
  /** `null` authoritatively clears a previously reported goal. */
  goal?: AgentGoalStatus | null;
}

export interface AgentInstanceModelSwitchResultMessage {
  type: "agent_model_switch_result";
  requestId: string;
  model?: string;
  error?: string;
  /** The switch cancelled a turn that was running; Hub decides its continuation. */
  interruptedTurn?: boolean;
}

export interface AgentInstanceEffortSwitchResultMessage {
  type: "agent_effort_switch_result";
  requestId: string;
  effort?: string;
  error?: string;
  /** The switch cancelled a turn that was running; Hub decides its continuation. */
  interruptedTurn?: boolean;
}

export interface AgentInstanceLifecycleMessage {
  type: "agent_lifecycle";
  requestId?: string;
  channelId?: string;
  agentId?: string;
  /** Globally unique live instance id. */
  instanceId?: string;
  /** Per-channel ordinal used only for channel-visible addressing/display. */
  channelInstanceId?: string;
  agentName?: string;
  layer: AgentLifecycleLayer;
  status: AgentLifecycleStatus;
  reason?: AgentLifecycleReason;
  detail?: string;
  snapshot?: AgentLifecycleSnapshot;
  /** RFC 3339 time a `usage_limited` provider account resets, when known. */
  resetsAt?: string;
  /** Tasks still pending when `background_tasks_interrupted` was observed. */
  pendingTasks?: number;
  ts?: string;
}

/** Observed outcome only. Hub owns retry timing, permits and the attempt budget. */
export interface AgentInstanceTurnRetryMessage {
  type: "agent_turn_retry";
  requestId?: string;
  operationId: string;
  action: "failed" | "completed" | "cancelled";
  threadId?: string;
  turnId?: string;
  safeToContinue?: boolean;
  errorMessage?: string;
  attemptToken?: string;
}

/**
 * The Instance's harness withdrew a question it had asked on a card: the
 * person answered in the Channel instead, or the turn it parked ended. A fact
 * only; the Hub settles the card, ends its wait and says so in the Channel.
 */
export interface AgentInstanceQuestionClosedMessage {
  type: "harness_question_closed";
  requestId?: string;
  channelId: string;
  /** The requestId the card was posted with, which names its message. */
  cardRequestId: string;
}

/**
 * What a `/config` or `/fast` control did, reported as facts by the Instance
 * that applied it; the Hub words the Channel notice.
 */
export interface AgentInstanceParameterControlResultMessage {
  type: "agent_parameter_control_result";
  requestId?: string;
  channelId: string;
  /** The control message this answers. */
  sourceMessageId: string;
  parameter?: string;
  action: "query" | "select" | "toggle";
  /** The parameter's value as the session holds it after the control. */
  current?: string;
  /** A retained selection the provider has not confirmed yet; never an observed value. */
  pending?: string;
  choices?: string[];
  /** The provider's own note on the parameter (cooldown, disabled). */
  notice?: string;
  /** The original error when the control failed. */
  error?: string;
}

export type AgentInstanceNetworkSampleMessage = ClientNetworkSample & {
  type: "client_network_sample";
  requestId?: string;
};

export interface AgentInstanceEventPublishMessage {
  type: "event_publish";
  requestId?: string;
  channelId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** Host-generated identity used to correlate live and on-demand trace views. */
  eventId?: string;
  /** Host clock for the locally retained trace event. */
  timestamp?: string;
}

export type AgentInstanceTraceAvailability = TraceInstanceHistoryAvailability;

/**
 * Response to one Hub-originated, exact-session trace history request.
 *
 * The Agent host is the only payload source. Hub binds this response to the
 * authenticated socket and never accepts a caller-selected host or instance.
 */
export interface AgentInstanceTraceHistoryResultMessage {
  type: "trace_history_result";
  requestId: string;
  instanceId: string;
  availability: AgentInstanceTraceAvailability;
  /** No older retained event remains and nothing was evicted. */
  complete: boolean;
  /** Newest first in the negotiated order. */
  events: ObservabilityEvent[];
  /**
   * Cursor for the next older page, null on the oldest page. A host that pages
   * always sends the key; its absence marks a host that ignores `before`.
   */
  nextCursor?: string | null;
}

/** Channel-local reports and acknowledgements emitted by one running Instance. */
export type AgentInstanceClientMessage =
  | AgentInstanceConnectMessage
  | { type: "ping"; requestId?: string }
  | { type: "refresh_auth"; requestId?: string; token: string }
  | { type: "unregister"; requestId?: string }
  | AgentInstanceJoinChannelMessage
  | AgentInstanceReplayChannelHistoryMessage
  | AgentInstanceLeaveChannelMessage
  | AgentInstanceChannelMessage
  | AgentInstanceChannelActivityMessage
  | AgentInstanceChannelMessageAck
  | AgentInstanceGetChannelHistoryMessage
  | AgentInstancePresenceUpdateMessage
  | AgentInstanceModelSwitchResultMessage
  | AgentInstanceEffortSwitchResultMessage
  | AgentInstanceLifecycleMessage
  | AgentInstanceTurnRetryMessage
  | AgentInstanceQuestionClosedMessage
  | AgentInstanceParameterControlResultMessage
  | AgentInstanceNetworkSampleMessage
  | AgentInstanceEventPublishMessage
  | AgentInstanceTraceHistoryResultMessage;

/**
 * One committed message plus the transport facts an Instance needs. The message
 * travels verbatim under `message` — the frame owns no message field of its
 * own, so a delivery can never describe a different message than history does.
 */
interface AgentChannelDelivery {
  message: ChannelMessage;
  clientMessageId?: string;
  ackRequired?: boolean;
  /**
   * What the receiving Instance is being asked to do with this delivery.
   *
   * Absent is work: the Instance acts on it. `context` is orientation the Hub
   * is serving — the bounded window a fresh join receives so the Instance
   * starts where a Human UI would, and system facts the Hub narrates about the
   * channel. Context is still acknowledged, so the cursor advances and it is
   * not served again; it just never starts a turn.
   *
   * A reader that predates this field must keep treating
   * every delivery as work rather than silently dropping any of it, so the
   * field can only ever remove spurious turns, never real ones.
   */
  deliveryIntent?: "context";
  /**
   * The message as this Instance reads it in a turn, rendered by the Hub for this recipient
   * (hub/src/agent-turn-message.ts). A runtime that predates it renders `message` itself.
   */
  prompt?: string;
}

type AgentLiveChannelDelivery = AgentChannelDelivery & {
  type: "channel_message_received";
  /** Fresh live delivery may cancel the provider's active turn. */
  interruptRequested?: boolean;
  /**
   * With `interruptRequested`: a runtime that can steer joins this delivery to
   * the active turn instead of cancelling it. A runtime that cannot, or that
   * predates the field, interrupts as before.
   */
  steerAllowed?: boolean;
};

type AgentReplayChannelDelivery = AgentChannelDelivery & {
  type: "channel_history_replay";
  /**
   * Hub's verdict on whether catch-up cancels the active turn, decided exactly
   * as for live delivery. Always present on catch-up from a Hub that decides
   * it; a runtime keeps its own older rule only when it is absent.
   */
  interruptRequested?: boolean;
  /** As for live delivery: the interrupt may steer the active turn instead. */
  steerAllowed?: boolean;
};

/** Channel-local deliveries and typed controls accepted by one running Instance. */
export type AgentInstanceServerMessage =
  | { type: "error"; requestId?: string; message: string;
      failure?: import("../runtime-operation-failure.js").RuntimeOperationFailure }
  | {
      type: "agent_instance_connected";
      agent: SerializedAgent;
      peers: SerializedAgent[];
      /**
       * Client message types this Hub accepts beyond the original set. A Hub
       * closes the socket on a type it does not know, so a runtime sends a
       * newer type only when it is listed here.
       */
      hubCapabilities?: string[];
    }
  | { type: "presence"; online: boolean; agent: SerializedAgent }
  | {
      type: "agent_lifecycle";
      channelId?: string;
      agentId: string;
      instanceId?: string;
      channelInstanceId?: string;
      agentName: string;
      layer: AgentLifecycleLayer;
      status: AgentLifecycleStatus;
      reason?: AgentLifecycleReason;
      detail?: string;
      snapshot?: AgentLifecycleSnapshot;
      ts: string;
    }
  | { type: "pong"; requestId?: string; ts: string }
  | { type: "auth_refreshed"; requestId?: string; ts: string }
  | { type: "unregistered"; requestId?: string }
  | { type: "shutdown_requested"; reason?: string }
  | {
      type: "trace_history_requested";
      /** Ask a supporting host to preserve receipt order and return positions. */
      receivedOrder?: boolean;
      requestId: string;
      instanceId: string;
      maxEvents: number;
      since?: string;
      /** Exclusive cursor from a previous page's `nextCursor`. */
      before?: string;
      /** Host-encoded byte budget for this page. */
      maxBytes?: number;
      /** With `since` only: the host may wait this long for a newer event. */
      waitMs?: number;
    }
  | { type: "agent_turn_retry_decision"; requestId: string; operationId: string;
      action: "retry" | "stop"; threadId: string; turnId: string;
      attemptToken: string; input?: string; reason?: string }
  | { type: "agent_model_switch_requested"; requestId: string; model: string }
  | { type: "agent_effort_switch_requested"; requestId: string; effort: string }
  /** The Hub's instruction that this Instance continue the turn its switches
   * cancelled, sent to the Instance alone: it is not a Channel message. Sent
   * only to a runtime that lists `switch_continuation_frame`. */
  | { type: "agent_switch_continuation"; channelId: string; instanceId: string; requestIds: string[]; prompt: string }
  | { type: "channel_joined"; requestId?: string; channelId: string; agent: SerializedAgent }
  | { type: "channel_left"; requestId?: string; channelId: string; agent: SerializedAgent }
  | AgentLiveChannelDelivery
  | AgentReplayChannelDelivery
  | { type: "channel_message_updated"; channelId: string; message: ChannelMessage }
  | {
      type: "channel_message_undelivered";
      requestId?: string;
      messageId: string;
      channelId: string;
      recipientId: string;
      recipientName?: string;
    }
  | {
      type: "channel_message_dispatched";
      requestId?: string;
      messageId: string;
      channelId: string;
      recipients: Array<{ id: string; name: string; online: boolean }>;
    }
  | {
      type: "channel_history";
      requestId?: string;
      channelId: string;
      messages: ChannelMessage[];
    }
  | { type: "enhanced_presence"; agent: SerializedAgent }
  | { type: "rate_limited"; requestId?: string; retryAfterMs: number; message: string }
  | { type: "observable_event"; event: ObservabilityEvent };

/** Hub-authored Channel message binding, stored under reserved xmatrixTurnRetry metadata.
 * The instruction is exclusively the canonical message body, never a private input field. */
/**
 * The Hub's instruction that one Instance continue the turn a live switch
 * cancelled, committed in the Channel for a runtime that predates the
 * `agent_switch_continuation` frame. Only the named Instance, still waiting
 * on one of the named switches, runs it.
 */
export interface ChannelSwitchContinuation {
  version: 1;
  instanceId: string;
  /** The switch requests that cancelled the turn and landed. */
  requestIds: string[];
}

export interface ChannelTurnRetry {
  version: 1;
  state: "issued";
  runId: string;
  instanceId: string;
  ownerUserId: string;
  operationId: string;
  requestId: string;
  attemptToken: string;
  attempt: number;
  expiresAt: number;
}
