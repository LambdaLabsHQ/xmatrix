import { daemonClientCompatibility as agentInstanceCompatibility } from "../legacy-client-compatibility";
import { plainDeliveryRecord } from "./delivery-record";
import type {
  AgentInstanceClientMessage,
  AgentInstanceConnectMessage,
  AgentInstanceServerMessage,
} from "@xmatrix/protocol/connections/agent-instance";
import {
  CLIENT_UPGRADE_REQUIRED_CLOSE_CODE,
  crossChannelReplyRelay,
  isLiveAgentStatus,
  type AgentStatus,
  type LiveAgentStatus,
  type MessageSender,
} from "@xmatrix/protocol";

import {
  AgentInstanceConnectionController,
  type AgentInstanceConnectionPort,
} from "../connections/agent-instance/controller";
import { RuntimeClientOperationError, type RuntimeFailureStage } from "./runtime-operation-failure";
import { RuntimeSocketState } from "./ordered-socket-dispatch";
import {
  parseAgentInstanceHibernationAttachment,
  serializeAgentInstanceHibernationAttachment,
  type AgentInstanceHibernationAttachment,
} from "./agent-instance-hibernation";
import {
  AGENT_HOST_TRACE_MAX_EVENTS,
  AGENT_HOST_TRACE_PAGE_MAX_BYTES,
  AGENT_HOST_TRACE_REQUEST_TIMEOUT_MS,
  agentHostTraceWaitMs,
  AgentHostTraceRequestBudget,
  sanitizeAgentHostTraceHistory,
  unavailableAgentHostTrace,
  type AgentHostTraceBinding,
  type AgentHostTraceReadRequest,
  type AgentHostTraceReadResult,
} from "../agent-host-trace";
import {
  agentChannelMessageDeliveryIntent,
  agentChannelMessageRequestsInterrupt,
  channelMessage,
} from "./channel-message-frame";
import {
  mergeAgentInstancePresentation,
  type AgentInstancePresentation,
} from "./agent-instance-presentation";

type Message<Type extends AgentInstanceClientMessage["type"]> = Extract<
  AgentInstanceClientMessage,
  { type: Type }
>;

/** A live switch is interactive: fail loudly well before the human retries. */
export const AGENT_INSTANCE_CONTROL_SWITCH_TIMEOUT_MS = 10_000;

export const AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES = [
  "client_network_sample",
  "unregister",
  "join_channel",
  "replay_channel_history",
  "leave_channel",
  "channel_message",
  "channel_activity",
  "channel_message_ack",
  "get_channel_history",
  "presence_update",
  "agent_model_switch_result",
  "agent_effort_switch_result",
  "agent_lifecycle",
  "event_publish",
] as const;

export type AgentInstanceAuthorityCapability = typeof AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES[number];

export interface AgentInstanceRunPrincipal {
  ownerUserId: string;
  agentId: string;
  agentName: string;
  /** Profile Space signed into the Run credential. */
  spaceId: string;
  runId: string;
  executionKey: string;
  channelId: string;
  machineId: string;
  hostId: string;
  runKind: "channel-instance" | "channel-about-session";
  channelWriteAllowed: boolean;
}

export interface AgentInstanceAuthorityRunBinding {
  kind: "channel-instance" | "channel-about-session";
  runId: string;
  agentId: string;
  instanceId: string;
  executionKey: string;
  channelId: string;
  machineId: string;
  hostId: string;
  status: "starting" | "running";
  instanceStatus: LiveAgentStatus;
  /** Authority version claimed by this connection, retained across hibernation. */
  connectionVersion?: number;
  /** System management Runs use the channel only as execution scope. */
  channelDeliveryEnabled?: boolean;
  /** Dense per-channel ordinal for `@agent:N` / memberPresence cards. */
  channelInstanceId?: string;
  cwd?: string;
}

export interface AgentInstanceAuthorityAuthentication {
  principal: AgentInstanceRunPrincipal;
  run: AgentInstanceAuthorityRunBinding;
  presentation?: AgentInstancePresentation;
  connected: Extract<AgentInstanceServerMessage, { type: "agent_instance_connected" }>;
}

export interface AgentInstanceRuntimeSession {
  principal: AgentInstanceRunPrincipal;
  run: AgentInstanceAuthorityRunBinding;
  connectedAt: string;
  lastSeenAt: string;
  clientVersion?: string;
  clientProtocolVersion?: number;
  presentation?: AgentInstancePresentation;
}

/** One live model/effort switch and the exact Instance answer it is waiting for. */
export interface AgentInstanceControlSwitchBinding {
  kind: "model" | "effort";
  ownerUserId: string;
  agentId: string;
  runId: string;
  instanceId: string;
  requestId: string;
}

export interface AgentInstanceControlSwitchResult {
  value?: string;
  error?: string;
}

export type AgentInstanceControlSwitchOutcome = import("../product-agent-model-effort").ProductAgentControlOutcome;

export interface AgentInstanceSocketBackend {
  readonly capabilities: ReadonlySet<AgentInstanceAuthorityCapability>;
  /**
   * Park one control request until its Instance answers. Optional because only
   * the production signal composition owns the process-memory waiter registry.
   */
  awaitControlResult?(
    binding: AgentInstanceControlSwitchBinding,
    timeoutMs: number,
  ): Promise<AgentInstanceControlSwitchResult>;
  authenticate(message: AgentInstanceConnectMessage): Promise<AgentInstanceAuthorityAuthentication>;
  refresh(token: string, session: Readonly<AgentInstanceRuntimeSession>): Promise<AgentInstanceRunPrincipal>;
  execute(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Exclude<AgentInstanceClientMessage, AgentInstanceConnectMessage | Message<"ping"> | Message<"refresh_auth">>,
  ): Promise<AgentInstanceServerMessage | readonly AgentInstanceServerMessage[] | undefined>;
  connected?(
    session: Readonly<AgentInstanceRuntimeSession>,
    deliver: (message: AgentInstanceServerMessage) => Promise<void>,
  ): void | Promise<void>;
  disconnected?(
    session: Readonly<AgentInstanceRuntimeSession>,
    details: { code?: number; reason?: string; wasClean?: boolean },
  ): void | Promise<void>;
}

export class AgentInstanceAuthorityCapabilityError extends Error {
  readonly missingCapabilities: readonly AgentInstanceAuthorityCapability[];

  constructor(missingCapabilities: readonly AgentInstanceAuthorityCapability[]) {
    super(`Agent Instance Authority port is missing required capabilities: ${missingCapabilities.join(", ")}`);
    this.name = "AgentInstanceAuthorityCapabilityError";
    this.missingCapabilities = missingCapabilities;
  }
}

export class AgentInstanceReconnectRequiredError extends Error {}

/**
 * Pure Authority composition for `/ws/agent-instances`.
 *
 * It deliberately has no legacy fallback. Every accepted frame is serialized
 * per socket, decoded by AgentInstanceConnectionController, and then sent only
 * to the injected Authority port. Missing semantics fail during construction.
 */
export class AgentInstanceRuntimeTransport {
  readonly controller: AgentInstanceConnectionController;
  private readonly sockets: RuntimeSocketState<AgentInstanceRuntimeSession, AgentInstanceServerMessage>;
  private readonly backend: AgentInstanceSocketBackend;
  private readonly authenticationSubject = "Agent Instance";
  private readonly pendingTraceRequests = new Map<string, {
    key: string;
    socket: WebSocket;
    binding: AgentHostTraceBinding;
    request: AgentHostTraceReadRequest;
    timer: ReturnType<typeof setTimeout>;
    resolves: Array<(result: AgentHostTraceReadResult) => void>;
  }>();
  private readonly pendingTraceRequestIdsByKey = new Map<string, string>();
  private readonly traceRequestBudget = new AgentHostTraceRequestBudget();
  private readonly terminalTraceInstances = new Set<string>();
  private readonly terminalTraceInstanceOrder: string[] = [];

  constructor(
    backend: AgentInstanceSocketBackend,
    private readonly traceRequestTimeoutMs = AGENT_HOST_TRACE_REQUEST_TIMEOUT_MS,
    private readonly onPresenceChange?: AgentInstancePresenceChangeHandler,
    private readonly onClientNetworkSample?: AgentInstanceClientNetworkSampleHandler,
    private readonly allowLegacyProtocol = false,
  ) {
    this.backend = backend;
    const missing = AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES.filter(
      (capability) => !backend.capabilities.has(capability),
    );
    if (missing.length > 0) throw new AgentInstanceAuthorityCapabilityError(missing);

    this.sockets = new RuntimeSocketState(
      "Agent Instance",
      (requestId, message, failure) => ({ type: "error", requestId, message, ...(failure ? { failure } : {}) }),
      async (session, details) => {
        // The disconnecting socket is already gone from `sessions`. A replacement
        // reconnect for the same Instance must not persist offline or overlay
        // disconnect over the live successor.
        if (agentInstanceHasLiveReplacement(
          Array.from(this.sockets.entries(), ([, live]) => live),
          session.run.instanceId,
        )) {
          return;
        }
        console.info("Agent transport disconnected", {
          instanceId: session.run.instanceId, runId: session.run.runId,
          code: details.code, wasClean: details.wasClean,
          connectionVersion: session.run.connectionVersion,
        });
        await this.backend.disconnected?.(session, details);
        if (agentInstanceHasLiveReplacement(
          Array.from(this.sockets.entries(), ([, live]) => live),
          session.run.instanceId,
        )) return;
        if (session.run.kind === "channel-instance") {
          await this.onPresenceChange?.({ reason: "disconnect", session });
        }
      },
    );

    const port: AgentInstanceConnectionPort = {
      ...this.sockets.endpointPort(),
      authorityMutation: (ws, message) => {
        // Trace history is retained by the exact Agent host and retrieved on
        // demand. Legacy clients may still publish it, but it must not enter
        // the authenticated authority queue or the Human realtime stream.
        if (message.type === "event_publish" && message.eventType === "llm_trace") return;
        this.sockets.ordered.schedule(this.dispatch(ws, message));
      },
      connect: (ws, message) => this.sockets.ordered.schedule(this.connect(ws, message)),
      ping: (ws, requestId) => this.sockets.send(ws, { type: "pong", requestId, ts: new Date().toISOString() }),
      networkSample: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      refreshAuth: (ws, message) => this.sockets.ordered.schedule(this.refresh(ws, message)),
      unregister: (ws, requestId) => this.sockets.ordered.schedule(this.dispatch(ws, { type: "unregister", requestId })),
      joinChannel: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      replayChannelHistory: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      leaveChannel: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      channelMessage: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      channelActivity: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      acknowledgeChannelMessage: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      getChannelHistory: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      updatePresence: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportModelSwitch: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportEffortSwitch: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportLifecycle: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      publishEvent: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      traceHistoryResult: (ws, message) => this.sockets.ordered.schedule(
        Promise.resolve().then(() => this.completeTraceHistory(ws, message)),
      ),
    };
    this.controller = new AgentInstanceConnectionController(port);
  }

  session(ws: WebSocket): Readonly<AgentInstanceRuntimeSession> | undefined { return this.sockets.get(ws); }
  hibernationAttachment(ws: WebSocket): AgentInstanceHibernationAttachment | undefined {
    const session = this.sockets.get(ws);
    return session ? serializeAgentInstanceHibernationAttachment(session) : undefined;
  }
  rehydrate(ws: WebSocket, value: unknown): boolean {
    const attachment = parseAgentInstanceHibernationAttachment(value);
    if (!attachment) return false;
    if (!agentInstanceCompatibility(
      attachment.session.clientVersion,
      attachment.session.clientProtocolVersion,
      this.allowLegacyProtocol,
    ).compatible) {
      ws.close(CLIENT_UPGRADE_REQUIRED_CLOSE_CODE, "Client upgrade required");
      return true;
    }
    if (this.hasNewerConnection(attachment.session.run)) {
      ws.close(1000, "Replaced by newer authenticated connection");
      return true;
    }
    for (const [oldSocket, oldSession] of this.sockets.entries()) {
      if (oldSocket === ws || !sameTraceHostSession(oldSession, attachment.session)) continue;
      this.failTraceRequestsForSocket(oldSocket);
      this.sockets.remove(oldSocket);
      oldSocket.close(1000, "Replaced by exact host hibernation restore");
    }
    this.sockets.restore(ws, attachment.session);
    void this.bindLiveDelivery(ws, attachment.session);
    if (attachment.session.run.kind === "channel-instance") {
      void this.onPresenceChange?.({ reason: "connect", session: attachment.session });
    }
    return true;
  }
  accept(ws: WebSocket): void { this.controller.socket.accept(ws); }
  handleClose(ws: WebSocket, code?: number, reason?: string, wasClean?: boolean): Promise<void> {
    this.failTraceRequestsForSocket(ws);
    return this.sockets.ordered.run(ws, () => this.controller.socket.handleClose(ws, code, reason, wasClean), false);
  }
  handleFrame(ws: WebSocket, frame: string | ArrayBuffer): Promise<void> { return this.sockets.ordered.run(ws, () => this.controller.handleFrame(ws, frame)); }
  liveSessions(): readonly Readonly<AgentInstanceRuntimeSession>[] {
    return Array.from(this.sockets.entries(), ([, session]) => session)
      .filter((session) => session.run.kind === "channel-instance");
  }

  /**
   * Push one committed channel message to every live Agent Instance bound to
   * that channel. Sender kind (human/agent) is not filtered — every exact host
   * socket receives the same delivery so follow-ups cannot strand mid-session.
   * The one exception is the Instance that wrote the message: it already knows
   * what it said, and handing it back arrives as a fresh turn about itself.
   */
  deliverChannelMessage(input: AgentChannelLiveDeliveryInput): AgentChannelLiveDeliveryResult {
    const message = channelMessage({
      ...input,
      from: messageSenderFromDelivery(input.from),
    });
    if (!message || (input.deliveryKind === "update" &&
        (message.body !== "" || (!message.recalledAt && !message.deletedAt)))) {
      return { matched: 0, delivered: 0, interrupted: 0 };
    }
    const channelId = message.channelId;
    const profilesByName = new Map<string, Set<string>>();
    for (const [, session] of this.sockets.entries()) {
      if (session.run.channelId !== channelId || session.run.kind !== "channel-instance") continue;
      const name = session.principal.agentName.trim().toLowerCase();
      const ids = profilesByName.get(name) ?? new Set<string>();
      ids.add(session.principal.agentId);
      profilesByName.set(name, ids);
    }
    const relay = crossChannelReplyRelay(input.metadata);
    // A relayed answer is work for the Instance that asked. While it is live the
    // others in its Channel only see it as context; once it is gone the answer
    // is work for whoever is here, so it is never stranded.
    const requester = relay?.requesterInstanceId;
    const requesterIsLive = !!requester && Array.from(this.sockets.entries()).some(([, session]) =>
      session.run.channelId === channelId && session.run.kind === "channel-instance" &&
      session.run.instanceId === requester);
    let matched = 0;
    let delivered = 0;
    let interrupted = 0;
    for (const [socket, session] of this.sockets.entries()) {
      if (session.run.channelId !== channelId) continue;
      if (session.run.kind !== "channel-instance") continue;
      if (input.deliveryKind !== "update" && deliveryWasAuthoredBy(input.from, session)) continue;
      // The Instance id alone names the replier: the relay's Agent id is the
      // sender snapshot's, which need not equal this socket principal's agentId.
      if (relay?.replierInstanceId === session.run.instanceId) continue;
      const answerIsAnothers = requesterIsLive && session.run.instanceId !== requester;
      matched += 1;
      if (input.deliveryKind === "update") {
        try {
          this.sockets.send(socket, { type: "channel_message_updated", channelId, message });
          delivered += 1;
        } catch {
          // Offline clients repair from authoritative history. A mutation never starts a turn.
        }
        continue;
      }
      // The receiving runtime is the only reliable authority on whether a turn
      // is active. Presence/runtime-state publication is best-effort and can
      // lag or be lost across a reconnect, so steering deliveries carry the
      // interrupt hint even when the projection says idle. Ordinary Agent peer
      // replies stay as work but queue behind the active turn; otherwise the
      // first Agent to answer cancels every slower participant.
      // The message is framed once for every audience and travels nested; only
      // the transport facts an Instance needs are added around it.
      const recipient = {
        agentName: session.principal.agentName,
        nameIsAmbiguous: (profilesByName.get(session.principal.agentName.trim().toLowerCase())?.size ?? 0) > 1,
        agentId: session.principal.agentId,
        channelInstanceId: session.run.channelInstanceId,
      };
      const deliveryIntent = answerIsAnothers ? "context" : agentChannelMessageDeliveryIntent(message, recipient);
      const interruptRequested = !answerIsAnothers && agentChannelMessageRequestsInterrupt(message, recipient);
      const outbound: Extract<AgentInstanceServerMessage, { type: "channel_message_received" }> = {
        type: "channel_message_received",
        message,
        ackRequired: true,
        ...(deliveryIntent === "context" ? { deliveryIntent } : {}),
        ...(interruptRequested ? { interruptRequested: true as const } : {}),
      };
      try {
        this.sockets.send(socket, outbound);
        delivered += 1;
        if (interruptRequested) interrupted += 1;
      } catch {
        // Best-effort live fanout; offline sockets drop without failing the commit path.
      }
    }
    return { matched, delivered, interrupted };
  }

  /**
   * Apply one `@agent:N /model|/effort` selection against the live socket.
   *
   * The Instance is the only authority on what it accepted, so this asks and
   * waits rather than recording an intent: an unanswered request is a failure,
   * not a silent switch.
   */
  async switchInstanceControl(input: {
    channelId: string;
    target: string;
    kind: "model" | "effort";
    value?: string;
  }): Promise<AgentInstanceControlSwitchOutcome> {
    const wanted = input.target.trim().toLowerCase();
    const candidates = Array.from(this.sockets.entries()).filter(([, session]) =>
      session.run.kind === "channel-instance" &&
      session.run.channelId === input.channelId &&
      (agentInstanceMentionTarget(session).toLowerCase() === wanted ||
        `${session.principal.agentId}:${session.run.channelInstanceId}`.toLowerCase() === wanted)
    );
    if (candidates.length !== 1) return { status: "no_instance" };
    const [socket, session] = candidates[0]!;

    const options = input.kind === "model"
      ? agentInstanceModelOptions(session)
      : agentInstanceEffortOptions(session);
    const current = input.kind === "model"
      ? session.presentation?.model
      : session.presentation?.effort;
    if (!input.value) {
      return {
        status: "catalog",
        options,
        ...(current ? { current } : {}),
      };
    }

    const selected = options.find((option) => option.toLowerCase() === input.value!.toLowerCase());
    if (!selected) {
      return {
        status: "error",
        message: `\`${input.value}\` is not one this instance offers.`,
      };
    }
    if (!this.backend.awaitControlResult) {
      return { status: "error", message: "This Runtime cannot apply live switches." };
    }

    const requestId = crypto.randomUUID();
    const binding: AgentInstanceControlSwitchBinding = {
      kind: input.kind,
      ownerUserId: session.principal.ownerUserId,
      agentId: session.principal.agentId,
      runId: session.principal.runId,
      instanceId: session.run.instanceId,
      requestId,
    };
    // Register before sending: a runtime fast enough to answer inside the same
    // task must still find a waiter to complete.
    const pending = this.backend.awaitControlResult(binding, AGENT_INSTANCE_CONTROL_SWITCH_TIMEOUT_MS);
    try {
      this.sockets.send(socket, input.kind === "model"
        ? { type: "agent_model_switch_requested", requestId, model: selected }
        : { type: "agent_effort_switch_requested", requestId, effort: selected });
    } catch (error) {
      void pending.catch(() => undefined);
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    let result: AgentInstanceControlSwitchResult;
    try {
      result = await pending;
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.error?.trim()) return { status: "error", message: result.error.trim() };
    const confirmed = result.value?.trim();
    if (!confirmed) {
      return { status: "error", message: "The instance did not confirm a selection." };
    }
    if (confirmed.toLowerCase() !== selected.toLowerCase()) {
      return {
        status: "error",
        message: `the instance confirmed \`${confirmed}\` instead of \`${selected}\`.`,
      };
    }
    return { status: "switched", selected: confirmed };
  }

  requestTraceHistory(
    instanceId: string,
    { maxEvents, since, before, waitMs: requestedWaitMs }: AgentHostTraceReadRequest,
  ): Promise<AgentHostTraceReadResult> {
    if (this.terminalTraceInstances.has(instanceId)) {
      return Promise.resolve({
        availability: "expired",
        complete: false,
        events: [],
        reason: "host_expired",
      });
    }
    const candidates = Array.from(this.sockets.entries()).filter(([, session]) =>
      session.run.instanceId === instanceId);
    if (candidates.length !== 1) return Promise.resolve(unavailableAgentHostTrace("host_offline"));
    const [socket, session] = candidates[0]!;
    const boundedMaxEvents = Math.max(1, Math.min(maxEvents, AGENT_HOST_TRACE_MAX_EVENTS));
    const waitMs = agentHostTraceWaitMs({ since, before, waitMs: requestedWaitMs });
    const key = JSON.stringify([instanceId, boundedMaxEvents, since ?? null, before ?? null, waitMs]);
    const coalescedRequestId = this.pendingTraceRequestIdsByKey.get(key);
    if (coalescedRequestId) {
      const pending = this.pendingTraceRequests.get(coalescedRequestId);
      if (pending?.socket === socket) {
        if (!this.traceRequestBudget.tryJoin(coalescedRequestId)) {
          return Promise.resolve(unavailableAgentHostTrace("host_overloaded"));
        }
        return new Promise((resolve) => pending.resolves.push(resolve));
      }
      this.pendingTraceRequestIdsByKey.delete(key);
    }
    const requestId = crypto.randomUUID();
    if (!this.traceRequestBudget.tryStart(instanceId, requestId)) {
      return Promise.resolve(unavailableAgentHostTrace("host_overloaded"));
    }
    const binding: AgentHostTraceBinding = {
      instanceId: session.run.instanceId,
      ownerUserId: session.principal.ownerUserId,
      agentId: session.principal.agentId,
      agentName: session.principal.agentName,
      channelId: session.run.channelId,
      allowedChannelIds: [session.run.channelId],
      runId: session.run.runId,
      machineId: session.run.machineId,
      hostId: session.run.hostId,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pendingTraceRequests.get(requestId);
        if (!pending) return;
        this.finishTraceRequest(requestId, unavailableAgentHostTrace("host_timeout"));
      }, this.traceRequestTimeoutMs + waitMs);
      this.pendingTraceRequests.set(requestId, {
        key,
        socket,
        binding,
        request: { maxEvents: boundedMaxEvents, since, before, ...(waitMs ? { waitMs } : {}) },
        timer,
        resolves: [resolve],
      });
      this.pendingTraceRequestIdsByKey.set(key, requestId);
      try {
        this.sockets.send(socket, {
          type: "trace_history_requested",
          requestId,
          instanceId,
          maxEvents: boundedMaxEvents,
          maxBytes: AGENT_HOST_TRACE_PAGE_MAX_BYTES,
          ...(since ? { since } : {}),
          ...(before ? { before } : {}),
          ...(waitMs ? { waitMs } : {}),
        });
      } catch {
        this.finishTraceRequest(requestId, unavailableAgentHostTrace("host_offline"));
      }
    });
  }

  terminateTraceSession(instanceId: string, reason = "Stopped from xMatrix web"): boolean {
    this.rememberTerminalTraceInstance(instanceId);
    let found = false;
    for (const [socket, session] of this.sockets.entries()) {
      if (session.run.instanceId !== instanceId) continue;
      found = true;
      this.finishTraceRequestsForSocket(socket, {
        availability: "expired",
        complete: false,
        events: [],
        reason: "host_expired",
      });
      try {
        this.sockets.send(socket, { type: "shutdown_requested", reason });
      } finally {
        this.sockets.remove(socket);
        socket.close(1000, reason);
      }
      // remove()+close() skips RuntimeSocketState.disconnect, so fire the same
      // Authority + Human presence path a clean websocket close would have taken.
      // Drop the live fanout entry before presence overlay so a lingering
      // socket cannot put this Instance back on the work dock.
      void Promise.resolve(
        this.backend.disconnected?.(session, { code: 1000, reason, wasClean: true }),
      ).then(() => {
        if (!agentInstanceHasLiveReplacement(this.liveSessions(), session.run.instanceId)) {
          return this.onPresenceChange?.({ reason: "disconnect", session });
        }
      });
    }
    return found;
  }

  private async connect(ws: WebSocket, message: AgentInstanceConnectMessage): Promise<void> {
    const compatibility = agentInstanceCompatibility(
      message.runtime.clientVersion,
      message.runtime.protocolVersion,
      this.allowLegacyProtocol,
    );
    if (!compatibility.compatible) {
      const rejectionMessage = compatibility.error || "Client upgrade required";
      this.sockets.send(ws, { type: "error", requestId: message.requestId, message: rejectionMessage });
      this.sockets.remove(ws);
      ws.close(CLIENT_UPGRADE_REQUIRED_CLOSE_CODE, "Client upgrade required");
      return;
    }
    let failureStage: RuntimeFailureStage = "relay.authenticate";
    let setupComplete = false;
    try {
      await this.sockets.answerOperation(ws, message.requestId, "Agent session request could not be completed", async () => {
        const authentication = await this.backend.authenticate(message);
        failureStage = "relay.validate_binding";
        assertRunBinding(message, authentication);
        if (this.hasNewerConnection(authentication.run)) {
          throw new RuntimeClientOperationError("agent_connection_superseded");
        }
        // Authority is the live Run/Instance authority. A Runtime-local terminal fence
        // (stop/unregister) must not permanently block reborn or a later Authority-
        // authenticated live binding for the same instanceId. Successful
        // authentication clears the fence so channel continuity can reconnect;
        // pure trace reads still see host_expired until that happens.
        this.forgetTerminalTraceInstance(authentication.run.instanceId);
        failureStage = "relay.replace_connection";
        for (const [oldSocket, oldSession] of this.sockets.entries()) {
          if (oldSocket === ws || oldSession.run.instanceId !== authentication.run.instanceId) continue;
          this.failTraceRequestsForSocket(oldSocket);
          this.sockets.remove(oldSocket);
          oldSocket.close(1000, "Replaced by authenticated reconnect");
        }
        const now = new Date().toISOString();
        failureStage = "relay.send_confirmation";
        this.sockets.establish(ws, {
          principal: authentication.principal,
          run: authentication.run,
          connectedAt: now,
          lastSeenAt: now,
          clientVersion: message.runtime.clientVersion,
          clientProtocolVersion: message.runtime.protocolVersion,
          ...(authentication.presentation ? { presentation: authentication.presentation } : {}),
        }, authentication.connected);
        failureStage = "relay.bind_delivery";
        await this.bindLiveDelivery(ws, this.sockets.get(ws)!);
        failureStage = "relay.publish_presence";
        if (authentication.run.kind === "channel-instance") {
          await this.onPresenceChange?.({ reason: "connect", session: this.sockets.get(ws)! });
        }
        setupComplete = true;
      }, () => failureStage);
    } finally {
      // Confirmation may have been sent before delivery binding failed. Do not
      // leave that half-initialized socket usable; its normal close handler
      // performs version-fenced offline cleanup without touching a successor.
      if (!setupComplete) ws.close(1011, "Agent connection setup failed");
    }
  }

  private async refresh(ws: WebSocket, message: Message<"refresh_auth">): Promise<void> {
    await this.sockets.authenticatedOperation(ws, message.requestId, this.authenticationSubject, "Agent session request could not be completed", async (session) => {
      let principal: AgentInstanceRunPrincipal;
      try {
        principal = await this.backend.refresh(message.token, session);
      } catch (error) {
        if (!(error instanceof AgentInstanceReconnectRequiredError)) throw error;
        if (this.sockets.has(ws)) this.sockets.send(ws, {
          type: "error", requestId: message.requestId, message: error.message,
        });
        ws.close(1012, "Refresh Agent Instance connection claim");
        return;
      }
      assertSamePrincipal(session.principal, principal);
      this.sockets.authenticationRefreshed(ws, session,
        (ts) => ({ type: "auth_refreshed", requestId: message.requestId, ts }));
    });
  }

  private hasNewerConnection(run: Readonly<AgentInstanceAuthorityRunBinding>): boolean {
    for (const [, live] of this.sockets.entries()) {
      if (live.run.instanceId === run.instanceId && live.run.connectionVersion !== undefined &&
          (run.connectionVersion === undefined || live.run.connectionVersion > run.connectionVersion)) return true;
    }
    return false;
  }

  private async dispatch(
    ws: WebSocket,
    message: Exclude<AgentInstanceClientMessage, AgentInstanceConnectMessage | Message<"ping"> | Message<"refresh_auth">>,
  ): Promise<void> {
    const requestId = "requestId" in message ? message.requestId : undefined;
    await this.sockets.authenticatedOperation(ws, requestId, this.authenticationSubject, "Agent session request could not be completed", async (session) => {
      const nextPresentation = message.type === "presence_update"
        ? mergeAgentInstancePresentation(session.presentation, message)
        : undefined;
      const output = await this.backend.execute(session, message);
      this.sockets.sendOutput(ws, output);
      if (message.type === "presence_update") {
        if (nextPresentation) session.presentation = nextPresentation;
        else delete session.presentation;
        if (isLiveAgentStatus(message.status)) {
          session.run.instanceStatus = message.status;
        }
        session.lastSeenAt = new Date().toISOString();
        if (session.run.kind === "channel-instance") {
          await this.onPresenceChange?.({
            reason: "update",
            session,
            status: message.status,
            ...(session.presentation?.activity
              ? { activity: session.presentation.activity }
              : {}),
          });
        }
      }
      if (session.run.kind === "channel-instance" && message.type === "client_network_sample") {
        await this.onClientNetworkSample?.({ session, message });
      }
      if (message.type === "unregister") {
        this.rememberTerminalTraceInstance(session.run.instanceId);
        this.finishTraceRequestsForSocket(ws, {
          availability: "expired",
          complete: false,
          events: [],
          reason: "host_expired",
        });
        this.sockets.remove(ws);
        if (session.run.kind === "channel-instance") {
          await this.onPresenceChange?.({ reason: "disconnect", session });
        }
      }
    });
  }

  private completeTraceHistory(ws: WebSocket, message: Message<"trace_history_result">): void {
    const pending = this.pendingTraceRequests.get(message.requestId);
    if (!pending || pending.socket !== ws || pending.binding.instanceId !== message.instanceId) return;
    const session = this.sockets.get(ws);
    if (!session || session.run.machineId !== pending.binding.machineId) return;
    this.finishTraceRequest(
      message.requestId,
      sanitizeAgentHostTraceHistory(message, pending.binding, pending.request) ??
        unavailableAgentHostTrace("invalid_host_response"),
    );
  }

  private failTraceRequestsForSocket(ws: WebSocket): void {
    this.finishTraceRequestsForSocket(ws, unavailableAgentHostTrace("host_offline"));
  }

  private finishTraceRequestsForSocket(ws: WebSocket, result: AgentHostTraceReadResult): void {
    for (const [requestId, pending] of this.pendingTraceRequests) {
      if (pending.socket !== ws) continue;
      this.finishTraceRequest(requestId, result);
    }
  }

  private finishTraceRequest(requestId: string, result: AgentHostTraceReadResult): void {
    const pending = this.pendingTraceRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingTraceRequests.delete(requestId);
    this.traceRequestBudget.finish(requestId);
    if (this.pendingTraceRequestIdsByKey.get(pending.key) === requestId) {
      this.pendingTraceRequestIdsByKey.delete(pending.key);
    }
    for (const resolve of pending.resolves) resolve(result);
  }

  private rememberTerminalTraceInstance(instanceId: string): void {
    if (this.terminalTraceInstances.has(instanceId)) return;
    this.terminalTraceInstances.add(instanceId);
    this.terminalTraceInstanceOrder.push(instanceId);
    while (this.terminalTraceInstanceOrder.length > 256) {
      const expired = this.terminalTraceInstanceOrder.shift();
      if (expired) this.terminalTraceInstances.delete(expired);
    }
  }

  private forgetTerminalTraceInstance(instanceId: string): void {
    if (!this.terminalTraceInstances.delete(instanceId)) return;
    const index = this.terminalTraceInstanceOrder.indexOf(instanceId);
    if (index >= 0) this.terminalTraceInstanceOrder.splice(index, 1);
  }

  private async bindLiveDelivery(ws: WebSocket, session: AgentInstanceRuntimeSession): Promise<void> {
    // Outbound sends must not wait behind the recipient's inbound handler.
    // Two concurrent presence handlers otherwise wait on each other's queues.
    // send() is synchronous and preserves call order; the exact session fence
    // still rejects callbacks retained across close/reconnect.
    await this.backend.connected?.(session, async (message) => {
      if (this.sockets.get(ws) !== session) throw new RuntimeClientOperationError("agent_delivery_binding_stale");
      this.sockets.send(ws, message);
    });
  }
}

export type AgentInstancePresenceChangeHandler = (input: {
  reason: "connect" | "update" | "disconnect";
  session: Readonly<AgentInstanceRuntimeSession>;
  status?: AgentStatus;
  /** Ephemeral activity label from presence_update (Room-parity for human channel cards). */
  activity?: string;
}) => void | Promise<void>;

export type AgentInstanceClientNetworkSampleHandler = (input: {
  session: Readonly<AgentInstanceRuntimeSession>;
  message: Message<"client_network_sample">;
}) => void | Promise<void>;

/** True when another live socket already replaced this Instance after close. */
export function agentInstanceHasLiveReplacement(
  sessions: Iterable<Readonly<AgentInstanceRuntimeSession>>,
  instanceId: string,
): boolean {
  const id = instanceId.trim();
  if (!id) return false;
  for (const session of sessions) {
    if (session.run.instanceId === id) return true;
  }
  return false;
}

export { agentInstanceCompatibility };

/** `<agent-name>:<channel-instance-number>` — the same label `@agent:N` addresses. */
function agentInstanceMentionTarget(session: Readonly<AgentInstanceRuntimeSession>): string {
  return `${session.principal.agentName || "agent"}:${session.run.channelInstanceId || "1"}`;
}

function agentInstanceModelOptions(
  session: Readonly<AgentInstanceRuntimeSession>,
): readonly string[] {
  const seen = new Set<string>();
  for (const model of session.presentation?.models ?? []) {
    const value = model.model?.trim() || model.id?.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/**
 * Efforts are a property of the selected model, so scope to it and fall back to
 * the default (then any) model rather than pooling every tier's efforts.
 */
function agentInstanceEffortOptions(
  session: Readonly<AgentInstanceRuntimeSession>,
): readonly string[] {
  const models = session.presentation?.models ?? [];
  const current = session.presentation?.model?.trim().toLowerCase();
  const scoped = (current
    ? models.find((model) =>
      model.model?.trim().toLowerCase() === current || model.id?.trim().toLowerCase() === current)
    : undefined) ?? models.find((model) => model.isDefault) ?? models[0];
  const seen = new Set<string>();
  for (const entry of scoped?.supportedReasoningEfforts ?? []) {
    const value = entry.reasoningEffort?.trim();
    if (value) seen.add(value);
  }
  if (seen.size === 0 && scoped?.defaultReasoningEffort?.trim()) {
    seen.add(scoped.defaultReasoningEffort.trim());
  }
  return [...seen];
}

function sameTraceHostSession(
  left: Readonly<AgentInstanceRuntimeSession>,
  right: Readonly<AgentInstanceRuntimeSession>,
): boolean {
  return left.run.instanceId === right.run.instanceId &&
    left.run.machineId === right.run.machineId;
}

function assertRunBinding(message: AgentInstanceConnectMessage, authentication: AgentInstanceAuthorityAuthentication): void {
  const { principal, run } = authentication;
  const context = message.runContext ?? {};
  if (!message.token.trim() || message.identityId !== principal.agentId || message.name.trim() !== principal.agentName ||
      context.runId !== principal.runId || context.executionKey !== principal.executionKey ||
      context.autoJoinChannelId !== principal.channelId || run.runId !== principal.runId ||
      context.machineId !== principal.machineId ||
      run.agentId !== principal.agentId || run.executionKey !== principal.executionKey ||
      run.channelId !== principal.channelId || run.machineId !== principal.machineId ||
      !run.instanceId ||
      !["starting", "running"].includes(run.status) || !isLiveAgentStatus(run.instanceStatus)) {
    throw new RuntimeClientOperationError("agent_run_binding_mismatch");
  }
}

function assertSamePrincipal(expected: AgentInstanceRunPrincipal, actual: AgentInstanceRunPrincipal): void {
  for (const key of ["ownerUserId", "agentId", "agentName", "spaceId", "runId", "executionKey", "channelId", "machineId"] as const) {
    if (actual[key] !== expected[key]) throw new RuntimeClientOperationError("agent_run_binding_mismatch");
  }
}

export type AgentChannelLiveDeliveryInput = {
  deliveryKind?: "update";
  recalledAt?: string;
  deletedAt?: string;
  channelId: string;
  messageId: string;
  sequence: number;
  entityVersion?: number;
  bodyHash?: string;
  body: string;
  from: Record<string, unknown>;
  sentAt: string;
  replyToMessageId?: string;
  replyTo?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
  appMentions?: unknown[];
};

export type AgentChannelLiveDeliveryResult = {
  matched: number;
  delivered: number;
  interrupted: number;
};


/**
 * Whether this exact Instance committed the message being fanned out.
 *
 * Scoped to the Instance, never the Agent: sibling Instances of one Agent are
 * separate participants and must keep hearing each other. The Agent half is
 * read from `agentId` or `identityId`, because the product sender
 * presentation stamps `identityId` as `agent:<agentId>` for an Agent whose id
 * is not already `agent:`-prefixed (a Channel-summoned Instance is one).
 */
function deliveryWasAuthoredBy(
  from: Record<string, unknown>,
  session: Readonly<AgentInstanceRuntimeSession>,
): boolean {
  if (from.kind !== "agent") return false;
  const instanceId = typeof from.instanceId === "string" ? from.instanceId.trim() : "";
  if (!instanceId || instanceId !== session.run.instanceId) return false;
  const agentId = session.principal.agentId;
  return from.agentId === agentId ||
    from.identityId === agentId ||
    from.identityId === `agent:${agentId}`;
}

function messageSenderFromDelivery(value: unknown): MessageSender | undefined {
  const record = plainDeliveryRecord(value);
  if (!record) return undefined;
  const kind = record.kind === "agent" || record.kind === "app" || record.kind === "user"
    ? record.kind
    : undefined;
  const label = typeof record.label === "string" && record.label.trim()
    ? record.label.trim()
    : typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : typeof record.agentName === "string" && record.agentName.trim()
        ? record.agentName.trim()
        : undefined;
  const userId = typeof record.userId === "string" ? record.userId : "";
  const email = typeof record.email === "string" ? record.email : "";
  if (!kind || !label) return undefined;
  return {
    kind,
    label,
    userId,
    email,
    ...(typeof record.identityId === "string" && record.identityId.trim()
      ? { identityId: record.identityId.trim() }
      : {}),
    ...(typeof record.agentName === "string" && record.agentName.trim()
      ? { agentName: record.agentName.trim() }
      : {}),
    ...(typeof record.instanceId === "string" && record.instanceId.trim()
      ? { instanceId: record.instanceId.trim() }
      : {}),
    ...(typeof record.avatarUrl === "string" && record.avatarUrl
      ? { avatarUrl: record.avatarUrl }
      : {}),
  };
}
