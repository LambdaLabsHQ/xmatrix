import {
  AgentInstanceRuntimeTransport,
  type AgentChannelLiveDeliveryInput,
  type AgentChannelLiveDeliveryResult,
  type AgentInstancePresenceChangeHandler,
  type AgentInstanceSocketBackend,
  type AgentInstanceRuntimeSession,
} from "./agent-instance-port";
import {
  HumanRuntimeTransport,
  type HumanChannelLiveDeliveryInput,
  type HumanChannelLiveDeliveryResult,
  type HumanPresenceChangeHandler,
  type HumanSocketBackend,
} from "./human-port";
import type { LiveHumanSessionSnapshot } from "./human-live-presence";
import type { AgentStatus } from "@xmatrix/protocol";
import type { ChannelAgentPresenceDelivery } from "./channel-agent-presence-delivery";
import { MachineDaemonRuntimeTransport, sameRouteIdentity, type MachineDaemonSocketBackend,
  type MachineDaemonRouteIdentity } from "./machine-daemon-port";
import type {
  HumanChannelCatalogChangedMessage,
  HumanTraceAccessServerMessage,
  HumanWorkspaceResourceChangedMessage,
} from "@xmatrix/protocol/connections/human";
import type { HumanProjectionPublishResult } from "../connections/human/registry";
import type { AgentHostTraceReadRequest, AgentHostTraceReadResult } from "../agent-host-trace";
import {
  liveAgentMachineRoute,
  liveAgentSessionSnapshots,
  type LiveAgentMachineRoute,
  type LiveAgentPresentationBinding,
} from "./agent-presence-snapshot";

export const RELAY_RUNTIME_HUMAN_CONNECT_PATH = "/internal/product-connect/human";
export const RELAY_RUNTIME_AGENT_INSTANCE_CONNECT_PATH = "/internal/product-connect/agent-instance";
export const RELAY_RUNTIME_MACHINE_DAEMON_CONNECT_PATH = "/internal/product-connect/machine-daemon";
export const RELAY_RUNTIME_MACHINE_DAEMON_CLAIM_PATH = "/internal/product-control/machine-daemon-claim";
export const RELAY_RUNTIME_MACHINE_DAEMON_WAIT_PATH = "/internal/product-control/machine-daemon-wait";
export const RELAY_RUNTIME_AGENT_TRACE_TERMINATE_PATH = "/internal/product-trace/instance-terminal";
export const RELAY_RUNTIME_CHANNEL_MESSAGE_PATH = "/internal/product/channel-message";
export const RELAY_RUNTIME_HUMAN_OBSERVABLE_EVENT_PATH = "/internal/product-human/observable-event";
export const RELAY_RUNTIME_CHANNEL_OBSERVABLE_EVENT_PATH = "/internal/product/channel-observable-event";

export interface RelayRuntimeProductPortFactory {
  human(): HumanSocketBackend;
  agentInstance(): AgentInstanceSocketBackend;
  machineDaemon(terminateInstance?: (instanceId: string) => void,
    deliverPending?: (identity: MachineDaemonRouteIdentity) => Promise<unknown>,
    quotaChanged?: (route: { ownerUserId: string; machineId: string }) => Promise<void>): MachineDaemonSocketBackend;
  onRegistrationQuotaChange?: (input: { ownerUserId: string; machineId: string;
    liveHumanSessions: readonly LiveHumanSessionSnapshot[];
    deliver: (userId: string, message: import("@xmatrix/protocol/connections/human").HumanServerMessage) => boolean;
  }) => Promise<void>;
  /** Optional process-memory Human presence fanout for product sockets. */
  onHumanPresenceChange?: HumanPresenceChangeHandler;
  onAgentPresenceChange?: (input: {
    reason: "connect" | "update" | "disconnect";
    session: Readonly<AgentInstanceRuntimeSession>;
    status?: AgentStatus;
    activity?: string;
    liveHumanSessions: readonly LiveHumanSessionSnapshot[];
    deliver: (userId: string, message: import("@xmatrix/protocol/connections/human").HumanServerMessage) => boolean;
    /**
     * A status report for one conversation: the card and the whole Channel at
     * once where it is shown (or the client takes no digest), otherwise only
     * the card, in the socket's digest.
     */
    deliverAgentPresence: (
      userId: string,
      channelId: string,
      card: Extract<import("@xmatrix/protocol/connections/human").HumanServerMessage, { type: "enhanced_presence" }> | undefined,
      channel: Extract<import("@xmatrix/protocol/connections/human").HumanServerMessage, { type: "channel_updated" }> | undefined,
    ) => boolean;
    /**
     * Whether the Machine Daemon hosting a live Instance's Run is reachable.
     * Presence only: an unreachable machine projects its Instances `offline`.
     */
    machineReachable?: (session: Readonly<AgentInstanceRuntimeSession>) => boolean;
  }) => void | Promise<void>;
}

export interface RelayRuntimeProductDurableObjectContext {
  acceptWebSocket(socket: WebSocket): void;
  getWebSockets(): WebSocket[];
}

/** Explicit dependency-injection factory; production route selection remains outside this module. */
export function createRelayRuntimeProductAdapter(
  context: RelayRuntimeProductDurableObjectContext,
  factory: RelayRuntimeProductPortFactory,
  options: { allowLegacyProtocol?: boolean } = {},
): RelayRuntimeProductCallbackAdapter {
  let agentInstance!: AgentInstanceRuntimeTransport;
  let machineDaemon!: MachineDaemonRuntimeTransport;
  // Hibernation restore brings sockets back in no promised order, so an
  // Instance may return before its daemon. Until restore finishes, no machine
  // is called unreachable on that evidence alone.
  const restore = { pending: true };
  const machineReachable = (route: LiveAgentMachineRoute) =>
    restore.pending || machineDaemon.isRouteReachable(route);
  const human = new HumanRuntimeTransport(factory.human(), {
    onPresenceChange: factory.onHumanPresenceChange,
    liveAgentSessions: () => liveAgentSessionSnapshots(agentInstance.liveSessions(), undefined, machineReachable),
    allowLegacyProtocol: options.allowLegacyProtocol === true,
  });
  const agentPresenceChange: AgentInstancePresenceChangeHandler | undefined = factory.onAgentPresenceChange
    ? (input) => factory.onAgentPresenceChange!({
        ...input,
        liveHumanSessions: human.liveSessions(),
        deliver: (userId, message) => human.deliverToUser(userId, message),
        deliverAgentPresence: (userId, channelId, card, channel) =>
          human.deliverAgentPresence(userId, channelId, card, channel),
        machineReachable: (session) => machineReachable(liveAgentMachineRoute(session)),
      })
    : undefined;
  agentInstance = new AgentInstanceRuntimeTransport(
    factory.agentInstance(),
    undefined,
    agentPresenceChange,
    async ({ session, message }) => {
      human.deliverToUser(session.principal.ownerUserId, {
        type: "observable_event",
        event: {
          id: crypto.randomUUID(),
          type: "client_network_sample",
          workspaceUserId: session.principal.ownerUserId,
          agentId: session.principal.agentId,
          agentName: session.principal.agentName,
          channelId: message.channelId,
          metadata: {
            clientKind: message.clientKind,
            mode: message.mode,
            networkState: message.networkState,
            result: message.result,
            instanceId: session.run.instanceId,
            reconnectAttempt: message.reconnectAttempt,
            lastServerActivityAgeMs: message.lastServerActivityAgeMs,
            reason: message.reason,
            latencyMs: message.latencyMs,
            entryCount: message.entryCount,
          },
          timestamp: new Date().toISOString(),
        },
      });
    },
    options.allowLegacyProtocol === true,
  );
  // The port delivers work it issues outside a frame through this transport,
  // which owns the socket order; the transport is built from the port.
  machineDaemon = new MachineDaemonRuntimeTransport(
    factory.machineDaemon(instanceId => {
      agentInstance.terminateTraceSession(instanceId, "Agent run ended on its authenticated host");
    }, identity => machineDaemon.claimPending(identity), async route => {
      await factory.onRegistrationQuotaChange?.({ ...route, liveHumanSessions: human.liveSessions(),
        deliver: (userId, message) => human.deliverToUser(userId, message) });
    }),
    options.allowLegacyProtocol === true,
    (instanceId) => {
      agentInstance.terminateTraceSession(instanceId, "Stopped by Machine Daemon");
    },
    (route) => {
      // The Instances on this machine did not change; how they must be shown did.
      if (!agentPresenceChange || restore.pending) return;
      for (const session of agentInstance.liveSessions()) {
        if (!sameRouteIdentity(liveAgentMachineRoute(session), route)) continue;
        void Promise.resolve(agentPresenceChange({ reason: "update", session })).catch((error) => {
          console.error("Agent Instance machine reachability fanout failed", error);
        });
      }
    },
  );
  const adapter = new RelayRuntimeProductCallbackAdapter(
    context,
    human,
    agentInstance,
    machineDaemon,
  );
  restore.pending = false;
  return adapter;
}

/**
 * Durable Object callback adapter for the three independent product socket
 * domains. Each domain keeps its own ownership set and transport; this class
 * only routes RelayRuntime's internal paths and WebSocket callbacks to the
 * transport that owns the socket. It defines no shared principal, session,
 * attachment, protocol or lifecycle model.
 */
export class RelayRuntimeProductCallbackAdapter {
  private readonly humanSockets = new WeakSet<WebSocket>();
  private readonly agentInstanceSockets = new WeakSet<WebSocket>();
  private readonly machineDaemonSockets = new WeakSet<WebSocket>();

  constructor(
    private readonly context: RelayRuntimeProductDurableObjectContext,
    private readonly human: HumanRuntimeTransport,
    private readonly agentInstance: AgentInstanceRuntimeTransport,
    private readonly machineDaemon: MachineDaemonRuntimeTransport,
  ) {
    for (const socket of context.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      // Only a product-domain attachment belongs to this adapter; other Runtime
      // attachment families stay with their own callback path.
      if (!isProductHibernationAttachment(attachment)) continue;
      if (!this.rehydrate(socket, attachment)) {
        socket.close(1008, "Invalid product hibernation attachment");
      }
    }
  }

  private rehydrate(socket: WebSocket, attachment: unknown): boolean {
    if (this.human.rehydrate(socket, attachment)) {
      if (this.human.session(socket)) this.humanSockets.add(socket);
      return true;
    }
    if (this.agentInstance.rehydrate(socket, attachment)) {
      if (this.agentInstance.session(socket)) this.agentInstanceSockets.add(socket);
      return true;
    }
    if (this.machineDaemon.rehydrate(socket, attachment)) {
      // Stale same-route hibernation may be accepted and closed without a
      // session; only live owners enter the ownership set.
      if (this.machineDaemon.session(socket)) this.machineDaemonSockets.add(socket);
      return true;
    }
    return false;
  }

  owns(socket: WebSocket): boolean {
    return this.humanSockets.has(socket) ||
      this.agentInstanceSockets.has(socket) ||
      this.machineDaemonSockets.has(socket);
  }

  liveHumanSessions() {
    return this.human.liveSessions();
  }

  /**
   * Channels this cell must be listed for. Agent sockets name the channels
   * they are in. A Human names only the channel they are viewing, so a
   * presence push can find their cell without registering every membership.
   */
  occupiedChannelIds(): string[] {
    const ids = this.agentInstance.liveSessions()
      .filter((session) => session.run.kind === "channel-instance")
      .map((session) => session.run.channelId);
    for (const session of this.human.liveSessions()) {
      if (session.focusedChannelId) ids.push(session.focusedChannelId);
    }
    return [...new Set(ids)];
  }

  liveAgentSessions(binding?: LiveAgentPresentationBinding) {
    return liveAgentSessionSnapshots(
      this.agentInstance.liveSessions(),
      binding,
      (route) => this.machineDaemon.isRouteReachable(route),
    );
  }

  publishHumanTraceAccess(
    message: HumanTraceAccessServerMessage,
  ): HumanProjectionPublishResult {
    return this.human.publishTraceAccess(message);
  }

  publishHumanChannelCatalogChanged(
    message: HumanChannelCatalogChangedMessage,
    recipientUserIds: readonly string[],
  ): HumanProjectionPublishResult {
    return this.human.publishChannelCatalogChanged(message, recipientUserIds);
  }

  publishHumanWorkspaceResourceChanged(
    message: HumanWorkspaceResourceChangedMessage,
    recipientUserIds: readonly string[],
  ): HumanProjectionPublishResult {
    return this.human.publishWorkspaceResourceChanged(message, recipientUserIds);
  }

  requestAgentTraceHistory(
    instanceId: string,
    request: AgentHostTraceReadRequest,
  ): Promise<AgentHostTraceReadResult> {
    return this.agentInstance.requestTraceHistory(instanceId, request);
  }

  deliverAgentChannelMessage(
    input: AgentChannelLiveDeliveryInput,
  ): AgentChannelLiveDeliveryResult {
    return this.agentInstance.deliverChannelMessage(input);
  }

  deliverHumanChannelMessage(
    input: HumanChannelLiveDeliveryInput,
  ): HumanChannelLiveDeliveryResult {
    return this.human.deliverChannelMessage(input);
  }

  deliverHumanObservableEvent(userId: string, event: import("@xmatrix/protocol").ObservabilityEvent): boolean {
    return this.human.deliverToUser(userId, { type: "observable_event", event });
  }

  /**
   * One Agent presence change, already delivered on the publishing cell.
   * Each recipient says which of the shared card, Channel, and immediate
   * frames this cell should hand to that user's sockets.
   */
  deliverChannelAgentPresence(delivery: ChannelAgentPresenceDelivery): number {
    let delivered = 0;
    for (const recipient of delivery.recipients) {
      const card = recipient.card && delivery.card
        ? { type: "enhanced_presence" as const, agent: delivery.card }
        : undefined;
      const channel = recipient.channel && delivery.channel
        ? { type: "channel_updated" as const, channel: delivery.channel }
        : undefined;
      let hit = false;
      if (recipient.digest) {
        if ((card || channel) &&
            this.human.deliverAgentPresence(recipient.userId, delivery.channelId, card, channel)) {
          hit = true;
        }
      } else {
        if (card && this.human.deliverToUser(recipient.userId, card)) hit = true;
        if (channel && this.human.deliverToUser(recipient.userId, channel)) hit = true;
      }
      if (recipient.immediate.includes("lifecycle") && delivery.lifecycle &&
          this.human.deliverToUser(recipient.userId, delivery.lifecycle)) hit = true;
      if (recipient.immediate.includes("observable") && delivery.observable &&
          this.human.deliverToUser(recipient.userId, delivery.observable)) hit = true;
      if (hit) delivered += 1;
    }
    return delivered;
  }

  terminateAgentTraceSession(instanceId: string, reason?: string): boolean {
    return this.agentInstance.terminateTraceSession(instanceId, reason);
  }

  switchAgentInstanceControl(
    input: Parameters<AgentInstanceRuntimeTransport["switchInstanceControl"]>[0],
  ): ReturnType<AgentInstanceRuntimeTransport["switchInstanceControl"]> {
    return this.agentInstance.switchInstanceControl(input);
  }

  claimPendingMachineDaemonCommands(identity: MachineDaemonRouteIdentity) {
    return this.machineDaemon.claimPending(identity);
  }

  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET" || !isRelayRuntimeProductConnectPath(path)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "Expected WebSocket upgrade" }, { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.context.acceptWebSocket(server);
    if (path === RELAY_RUNTIME_HUMAN_CONNECT_PATH) {
      this.humanSockets.add(server);
      this.human.accept(server);
    } else if (path === RELAY_RUNTIME_AGENT_INSTANCE_CONNECT_PATH) {
      this.agentInstanceSockets.add(server);
      this.agentInstance.accept(server);
    } else {
      this.machineDaemonSockets.add(server);
      this.machineDaemon.accept(server);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<boolean> {
    if (this.humanSockets.has(socket)) await this.human.handleFrame(socket, message);
    else if (this.agentInstanceSockets.has(socket)) await this.agentInstance.handleFrame(socket, message);
    else if (this.machineDaemonSockets.has(socket)) await this.machineDaemon.handleFrame(socket, message);
    else return false;
    // The frame may have closed the socket; only a still-owned one persists state.
    const attachment = this.humanSockets.has(socket) ? this.human.hibernationAttachment(socket)
      : this.agentInstanceSockets.has(socket) ? this.agentInstance.hibernationAttachment(socket)
      : this.machineDaemonSockets.has(socket) ? this.machineDaemon.hibernationAttachment(socket)
      : undefined;
    if (attachment !== undefined) socket.serializeAttachment(attachment);
    return true;
  }

  async webSocketClose(
    socket: WebSocket,
    code?: number,
    reason?: string,
    wasClean?: boolean,
  ): Promise<boolean> {
    if (this.humanSockets.delete(socket)) {
      await this.human.handleClose(socket, code, reason, wasClean);
      return true;
    }
    if (this.agentInstanceSockets.delete(socket)) {
      await this.agentInstance.handleClose(socket, code, reason, wasClean);
      return true;
    }
    if (this.machineDaemonSockets.delete(socket)) {
      await this.machineDaemon.handleClose(socket, code, reason, wasClean);
      return true;
    }
    return false;
  }

  async webSocketError(socket: WebSocket): Promise<boolean> {
    const handled = await this.webSocketClose(socket, 1011, "Runtime socket error", false);
    if (handled) socket.close(1011, "Runtime socket error");
    return handled;
  }
}

export function isRelayRuntimeProductConnectPath(path: string): boolean {
  return path === RELAY_RUNTIME_HUMAN_CONNECT_PATH ||
    path === RELAY_RUNTIME_AGENT_INSTANCE_CONNECT_PATH ||
    path === RELAY_RUNTIME_MACHINE_DAEMON_CONNECT_PATH;
}

export function isProductHibernationAttachment(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const domain = (value as { domain?: unknown }).domain;
  return domain === "human" || domain === "agent_instance" || domain === "machine_daemon";
}
