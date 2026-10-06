import type {
  HumanChannelCatalogChangedMessage,
  HumanClientMessage,
  HumanConnectMessage,
  HumanServerMessage,
  HumanTraceAccessServerMessage,
  HumanWorkspaceResourceChangedMessage,
} from "@xmatrix/protocol/connections/human";
import { HUMAN_CLIENT_PRESENCE_DIGEST } from "@xmatrix/protocol/connections/human";
import {
  CLIENT_UPGRADE_REQUIRED_CLOSE_CODE,
  HUMAN_AUTH_INVALID_FAILURE_CODE,
  HUMAN_AUTH_REQUIRED_CLOSE_CODE,
  evaluateClientCompatibility,
  type ClientCompatibilityDecision,
} from "@xmatrix/protocol";
import {
  channelMessage,
  type ChannelMessageFrameInput,
} from "./channel-message-frame";

import {
  HumanConnectionController,
  type HumanConnectionPort,
} from "../connections/human/controller";
import type { HumanProjectionPublishResult, HumanProjectionSender, HumanProjectionSession } from "../connections/human/registry";
import { publishHumanChannelCatalogChangedToSessions, publishHumanTraceAccessToSessions, publishHumanWorkspaceResourceChangedToSessions } from "../connections/human/registry";
import { RuntimeSocketState } from "./ordered-socket-dispatch";
import { HumanPresenceDigests } from "./human-presence-digest";
import { RuntimeClientOperationError } from "./runtime-operation-failure";
import {
  parseHumanHibernationAttachment,
  serializeHumanHibernationAttachment,
  type HumanHibernationAttachment,
} from "./human-hibernation";
import {
  liveHumanSessionSnapshots,
  type LiveHumanSessionSnapshot,
} from "./human-live-presence";
import type { LiveAgentSessionSnapshot } from "./agent-presence-snapshot";
import { admittedLegacyProtocolVersion } from "../legacy-client-compatibility";

type Message<Type extends HumanClientMessage["type"]> = Extract<
  HumanClientMessage,
  { type: Type }
>;
type HumanUser = Extract<HumanServerMessage, { type: "human_connected" }>["user"];
type AuthorityOutput = HumanServerMessage | readonly HumanServerMessage[] | undefined;
/** RFC 6455 "Try Again Later": the server could not finish the handshake right now. */
const TRY_AGAIN_LATER_CLOSE_CODE = 1013;
/** How long a refused sign-in's socket stays open, bounding how fast a client that redials only on close can retry. */
const REFUSED_SIGN_IN_CLOSE_DELAY_MS = 30_000;

export const HUMAN_AUTHORITY_REQUIRED_CAPABILITIES = [
  "authenticate",
  "focus_channel",
  "disconnect",
] as const;

export type HumanAuthorityCapability = typeof HUMAN_AUTHORITY_REQUIRED_CAPABILITIES[number];

export interface HumanAuthorityAuthentication {
  user: HumanUser;
  connected: Extract<HumanServerMessage, { type: "human_connected" }>;
}

export interface HumanRuntimeSession {
  user: HumanUser;
  connectedAt: string;
  lastSeenAt: string;
  focusedChannelId: string | null;
  deviceClient?: string;
  deviceLabel?: string;
  platform?: string;
  clientVersion?: string;
  clientProtocolVersion?: number;
  /** The client takes Agent presence for conversations it is not showing as a once-a-second digest. */
  presenceDigest?: true;
}

/**
 * Live Human presence fanout hook. Implementations may publish channel_updated
 * snapshots; failures must never fail the Human socket frame itself.
 */
export type HumanPresenceChangeHandler = (input: {
  reason: "connect" | "focus" | "disconnect";
  previousFocusedChannelId: string | null;
  nextFocusedChannelId: string | null;
  session: Readonly<HumanRuntimeSession>;
  liveSessions: readonly LiveHumanSessionSnapshot[];
  /** Authenticated live Agent presentations available for the focused channel. */
  liveAgentSessions: readonly LiveAgentSessionSnapshot[];
  deliver: (userId: string, message: HumanServerMessage) => void;
}) => void | Promise<void>;

/**
 * Abstract typed Authority boundary. Concrete HTTP/DO dispatch belongs to the
 * Worker composition root; this transport cannot obtain or fall back to a
 * legacy authority binding.
 */
export interface HumanSocketBackend {
  readonly capabilities: ReadonlySet<HumanAuthorityCapability>;
  authenticate(message: HumanConnectMessage): Promise<HumanAuthorityAuthentication>;
  focusChannel(
    session: Readonly<HumanRuntimeSession>,
    message: Message<"user_focus_channel">,
  ): Promise<AuthorityOutput>;
  disconnected(
    session: Readonly<HumanRuntimeSession>,
    details: { code?: number; reason?: string; wasClean?: boolean },
  ): void | Promise<void>;
}

export class HumanAuthorityCapabilityError extends Error {
  readonly missingCapabilities: readonly HumanAuthorityCapability[];

  constructor(missingCapabilities: readonly HumanAuthorityCapability[]) {
    super(`Human Authority port is missing required capabilities: ${missingCapabilities.join(", ")}`);
    this.name = "HumanAuthorityCapabilityError";
    this.missingCapabilities = missingCapabilities;
  }
}

/** Pure-Authority transport adapter for `/ws/humans`. */
export class HumanRuntimeTransport {
  readonly controller: HumanConnectionController;
  private readonly backend: HumanSocketBackend;
  private readonly sockets: RuntimeSocketState<HumanRuntimeSession, HumanServerMessage>;
  private readonly onPresenceChange?: HumanPresenceChangeHandler;
  private readonly refusedSignInCloseDelayMs: number;
  private readonly liveAgentSessions?: () => readonly LiveAgentSessionSnapshot[];
  private readonly allowLegacyProtocol: boolean;
  private readonly presenceDigests = new HumanPresenceDigests((socket, message) => {
    if (this.sockets.get(socket)) this.sockets.send(socket, message);
  });
  private readonly projectionSender: HumanProjectionSender = (socket, message) => {
    this.sockets.send(socket, message);
    return true;
  };

  constructor(backend: HumanSocketBackend, options?: {
    onPresenceChange?: HumanPresenceChangeHandler;
    liveAgentSessions?: () => readonly LiveAgentSessionSnapshot[];
    allowLegacyProtocol?: boolean;
    refusedSignInCloseDelayMs?: number;
  }) {
    this.backend = backend;
    this.refusedSignInCloseDelayMs = options?.refusedSignInCloseDelayMs ?? REFUSED_SIGN_IN_CLOSE_DELAY_MS;
    this.onPresenceChange = options?.onPresenceChange;
    this.liveAgentSessions = options?.liveAgentSessions;
    this.allowLegacyProtocol = options?.allowLegacyProtocol === true;
    const missing = HUMAN_AUTHORITY_REQUIRED_CAPABILITIES.filter(
      (capability) => !backend.capabilities.has(capability),
    );
    if (missing.length > 0) throw new HumanAuthorityCapabilityError(missing);

    this.sockets = new RuntimeSocketState(
      "Human",
      (requestId, message, failure) => ({ type: "error", requestId, message, ...(failure ? { failure } : {}) }),
      (session, details) => this.handleDisconnected(session, details),
    );

    const port: HumanConnectionPort = {
      ...this.sockets.endpointPort(),
      connect: (ws, message) => this.sockets.ordered.schedule(this.connect(ws, message)),
      focusChannel: (ws, message) => this.sockets.ordered.schedule(this.focusChannel(ws, message)),
      ping: (ws, requestId) => this.sockets.send(ws, {
        type: "pong",
        requestId,
        ts: new Date().toISOString(),
      }),
    };
    this.controller = new HumanConnectionController(port);
  }

  accept(ws: WebSocket): void { this.controller.socket.accept(ws); }
  handleFrame(ws: WebSocket, frame: string | ArrayBuffer): Promise<void> { return this.sockets.ordered.run(ws, () => this.controller.handleFrame(ws, frame)); }
  handleClose(ws: WebSocket, code?: number, reason?: string, wasClean?: boolean): Promise<void> { return this.sockets.ordered.run(ws, () => this.controller.socket.handleClose(ws, code, reason, wasClean), false); }
  session(ws: WebSocket): Readonly<HumanRuntimeSession> | undefined { return this.sockets.get(ws); }
  liveSessions(): readonly LiveHumanSessionSnapshot[] {
    return liveHumanSessionSnapshots(Array.from(this.sockets.entries(), ([, session]) => session));
  }
  hibernationAttachment(ws: WebSocket): HumanHibernationAttachment | undefined {
    const session = this.sockets.get(ws);
    return session ? serializeHumanHibernationAttachment(session) : undefined;
  }
  rehydrate(ws: WebSocket, value: unknown): boolean {
    const attachment = parseHumanHibernationAttachment(value);
    if (!attachment) return false;
    const compatibility = humanSessionCompatibility(
      attachment.session,
      this.allowLegacyProtocol,
    );
    if (!compatibility.compatible) {
      ws.close(CLIENT_UPGRADE_REQUIRED_CLOSE_CODE, "Client upgrade required");
      return true;
    }
    this.sockets.restore(ws, attachment.session);
    return true;
  }
  publishTraceAccess(message: HumanTraceAccessServerMessage): HumanProjectionPublishResult {
    const sessions = Array.from(this.sockets.entries(), ([socket, session]) =>
      [socket, { userId: session.user.id }] as const);
    return publishHumanTraceAccessToSessions({ message }, sessions, (socket, outbound) => {
      this.sockets.send(socket, outbound);
      return true;
    });
  }
  publishChannelCatalogChanged(
    message: HumanChannelCatalogChangedMessage,
    recipientUserIds: readonly string[],
  ): HumanProjectionPublishResult {
    return publishHumanChannelCatalogChangedToSessions(
      { message, recipientUserIds }, this.projectionSessions(), this.projectionSender,
    );
  }
  publishWorkspaceResourceChanged(
    message: HumanWorkspaceResourceChangedMessage,
    recipientUserIds: readonly string[],
  ): HumanProjectionPublishResult {
    return publishHumanWorkspaceResourceChangedToSessions(
      { message, recipientUserIds }, this.projectionSessions(), this.projectionSender,
    );
  }
  private projectionSessions(): Array<readonly [WebSocket, HumanProjectionSession]> {
    return Array.from(this.sockets.entries(), ([socket, session]) =>
      [socket, { userId: session.user.id }] as const);
  }
  /**
   * An Agent's status report for one conversation. A socket showing that
   * conversation, or one that cannot take digests, gets the Agent card and the
   * whole Channel at once, as before. Every other socket of the user gets only
   * the card, in its next once-a-second `presence_digest`, where a newer card
   * for the same Agent and Instances replaces it. Many working Agents then
   * cost each such socket one frame a second, not one per report.
   */
  deliverAgentPresence(
    userId: string,
    channelId: string,
    card: Extract<HumanServerMessage, { type: "enhanced_presence" }> | undefined,
    channel: Extract<HumanServerMessage, { type: "channel_updated" }> | undefined,
  ): boolean {
    let delivered = false;
    for (const [socket, session] of this.sockets.entries()) {
      if (session.user.id !== userId) continue;
      delivered = true;
      if (!session.presenceDigest || session.focusedChannelId === channelId) {
        if (card) this.sockets.send(socket, card);
        if (channel) this.sockets.send(socket, channel);
      } else if (card) {
        this.presenceDigests.add(socket, card.agent);
      }
    }
    return delivered;
  }

  deliverToUser(userId: string, message: HumanServerMessage): boolean {
    let delivered = false;
    for (const [socket, session] of this.sockets.entries()) {
      if (session.user.id !== userId) continue;
      this.sockets.send(socket, message);
      delivered = true;
    }
    return delivered;
  }

  /**
   * CORE_ACTIVE live fanout for committed channel messages. Recipients are the
   * exact user ids Authority authorized for the channel (Room sendToChannelUserSubscribers).
   */
  deliverChannelMessage(input: HumanChannelLiveDeliveryInput): HumanChannelLiveDeliveryResult {
    if (!humanChannelDeliveryFrame(input)) return { matched: 0, delivered: 0 };
    const recipientUserIds = new Set(
      (Array.isArray(input.recipientUserIds) ? input.recipientUserIds : [])
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim()),
    );
    let matched = 0;
    let delivered = 0;
    for (const [socket, session] of this.sockets.entries()) {
      if (!recipientUserIds.has(session.user.id)) continue;
      matched += 1;
      try {
        const outbound = humanChannelDeliveryFrame(input, session.user.id)!;
        this.sockets.send(socket, outbound);
        delivered += 1;
      } catch {
        // Best-effort live fanout; offline sockets drop without failing the commit path.
      }
    }
    return { matched, delivered };
  }

  private async connect(ws: WebSocket, message: HumanConnectMessage): Promise<void> {
    const compatibility = humanMessageCompatibility(message, this.allowLegacyProtocol);
    if (!compatibility.compatible) {
      const upgradeMessage = compatibility.error || "Client upgrade required";
      this.sockets.send(ws, { type: "error", requestId: message.requestId, message: upgradeMessage });
      this.sockets.remove(ws);
      ws.close(CLIENT_UPGRADE_REQUIRED_CLOSE_CODE, "Client upgrade required");
      return;
    }
    try {
      const authentication = await this.backend.authenticate(message);
      assertAuthentication(message, authentication);
      const now = new Date().toISOString();
      const device = message.device && typeof message.device === "object" && !Array.isArray(message.device)
        ? message.device as Record<string, unknown>
        : {};
      const deviceClient = typeof device.client === "string" ? device.client.trim() : "";
      const deviceLabel = typeof device.label === "string" ? device.label.trim() : "";
      const platform = typeof device.platform === "string" ? device.platform.trim() : "";
      const clientVersion = typeof device.version === "string" ? device.version.trim() : "";
      const clientProtocolVersion = Number(device.protocolVersion);
      const presenceDigest = Array.isArray(device.capabilities) &&
        device.capabilities.includes(HUMAN_CLIENT_PRESENCE_DIGEST);
      const session: HumanRuntimeSession = {
        user: authentication.user,
        connectedAt: now,
        lastSeenAt: now,
        focusedChannelId: null,
        ...(deviceClient ? { deviceClient } : {}),
        ...(deviceLabel ? { deviceLabel } : {}),
        ...(platform ? { platform } : {}),
        ...(clientVersion ? { clientVersion } : {}),
        ...(Number.isSafeInteger(clientProtocolVersion) ? { clientProtocolVersion } : {}),
        ...(presenceDigest ? { presenceDigest: true as const } : {}),
      };
      this.sockets.establish(ws, session, authentication.connected);
      // Pure-Authority does not host live agent_list inventory (that is REST/profile
      // authority). Still emit an empty agent_list so clients finish handshake
      // the same way they did on RelayRoom and do not wait forever for peers.
      this.sockets.send(ws, {
        type: "agent_list",
        requestId: message.requestId,
        agents: [],
      });
      await this.emitPresenceChange({
        reason: "connect",
        previousFocusedChannelId: null,
        nextFocusedChannelId: null,
        session,
      });
    } catch (error) {
      this.sockets.sendFailure(ws, message.requestId, error, "Could not connect this session");
      const code = error instanceof RuntimeClientOperationError ? error.failure.code : undefined;
      if (code === HUMAN_AUTH_INVALID_FAILURE_CODE) {
        // Names the client build, so a client that keeps redialling a refused token can be found.
        console.warn("Human sign-in refused", { diagnosticId: (error as RuntimeClientOperationError).failure.diagnosticId, ...refusedClient(message.device) });
        // The same token would be refused again: close so the client renews it before redialling.
        this.holdRefusedSocket(ws, HUMAN_AUTH_REQUIRED_CLOSE_CODE, "Sign in again");
      } else if (code === "human_rate_limited") {
        this.holdRefusedSocket(ws, TRY_AGAIN_LATER_CLOSE_CODE, "Try again later");
      } else if (!this.sockets.get(ws)) {
        // Not left open unauthenticated: the client redials with backoff and the same token.
        ws.close(TRY_AGAIN_LATER_CLOSE_CODE, "Try again later");
      }
    }
  }

  /**
   * Current clients act on the error frame at once. A client that only redials
   * on close (an old bundle left open) is held here, so it cannot loop faster.
   */
  private holdRefusedSocket(ws: WebSocket, closeCode: number, reason: string): void {
    this.sockets.remove(ws);
    const close = () => ws.close(closeCode, reason);
    if (this.refusedSignInCloseDelayMs > 0) setTimeout(close, this.refusedSignInCloseDelayMs);
    else close();
  }

  private async focusChannel(ws: WebSocket, message: Message<"user_focus_channel">): Promise<void> {
    const session = this.sockets.get(ws);
    if (!session) return this.sockets.sendUnauthenticated(ws, message.requestId, "Human");
    if (message.channelId !== null && (typeof message.channelId !== "string" || !message.channelId.trim())) {
      return this.sockets.send(ws, { type: "error", requestId: message.requestId, message: "channelId must be a non-empty string or null" });
    }
    if (message.historyLimit !== undefined &&
        (!Number.isSafeInteger(message.historyLimit) ||
          message.historyLimit < 1 || message.historyLimit > 50)) {
      return this.sockets.send(ws, {
        type: "error",
        requestId: message.requestId,
        message: "historyLimit must be an integer between 1 and 50",
      });
    }
    try {
      const previousFocusedChannelId = session.focusedChannelId;
      const nextFocusedChannelId = message.channelId;
      if (previousFocusedChannelId === nextFocusedChannelId) {
        this.sockets.sendOutput(ws, await this.backend.focusChannel(session, message));
        return;
      }
      const output = await this.backend.focusChannel(session, message);
      session.focusedChannelId = nextFocusedChannelId;
      this.sockets.sendOutput(ws, output);
      await this.emitPresenceChange({
        reason: "focus",
        previousFocusedChannelId,
        nextFocusedChannelId,
        session,
      });
    } catch (error) {
      this.sockets.sendFailure(ws, message.requestId, error, "Could not open this Channel");
    }
  }

  private async handleDisconnected(
    session: Readonly<HumanRuntimeSession>,
    details: { code?: number; reason?: string; wasClean?: boolean },
  ): Promise<void> {
    try {
      await this.backend.disconnected(session, details);
    } finally {
      await this.emitPresenceChange({
        reason: "disconnect",
        previousFocusedChannelId: session.focusedChannelId,
        nextFocusedChannelId: null,
        session,
      });
    }
  }

  private async emitPresenceChange(input: {
    reason: "connect" | "focus" | "disconnect";
    previousFocusedChannelId: string | null;
    nextFocusedChannelId: string | null;
    session: Readonly<HumanRuntimeSession>;
  }): Promise<void> {
    if (!this.onPresenceChange) return;
    try {
      await this.onPresenceChange({
        ...input,
        liveSessions: this.liveSessions(),
        liveAgentSessions: this.liveAgentSessions?.() ?? [],
        deliver: (userId, message) => {
          for (const [socket, candidate] of this.sockets.entries()) {
            if (candidate.user.id === userId) this.sockets.send(socket, message);
          }
        },
      });
    } catch {
      // Live presence is best-effort process memory; never fail the Human frame.
    }
  }
}

export function humanMessageCompatibility(
  message: HumanConnectMessage,
  allowLegacyProtocol = false,
): ClientCompatibilityDecision {
  return evaluateClientCompatibility(humanCompatibilityIdentity(
    message.device?.client,
    message.device?.version,
    message.device?.protocolVersion,
    message.device?.platform,
    allowLegacyProtocol,
  ));
}

export function humanSessionCompatibility(
  session: Readonly<HumanRuntimeSession>,
  allowLegacyProtocol = false,
): ClientCompatibilityDecision {
  return evaluateClientCompatibility(humanCompatibilityIdentity(
    session.deviceClient,
    session.clientVersion,
    session.clientProtocolVersion,
    session.platform,
    allowLegacyProtocol,
  ));
}

function humanCompatibilityIdentity(
  client: unknown,
  version: unknown,
  protocolVersion: unknown,
  platform: unknown,
  allowLegacyProtocol: boolean,
): unknown {
  const normalized = typeof client === "string" ? client.trim().toLowerCase() : "";
  const component = normalized === "cli" || normalized.startsWith("xmatrix-cli")
    ? "cli"
    : ["web", "desktop", "ios", "android"].includes(normalized)
      ? "app"
      : undefined;
  return {
    component,
    version,
    protocolVersion: admittedLegacyProtocolVersion(
      component,
      version,
      protocolVersion,
      allowLegacyProtocol,
    ),
    platform,
  };
}

function assertAuthentication(message: HumanConnectMessage, value: HumanAuthorityAuthentication): void {
  if (!message.token.trim() || value.connected.type !== "human_connected" ||
      !value.user?.id || value.connected.user?.id !== value.user.id ||
      value.connected.requestId !== message.requestId) {
    throw new Error("Human handshake does not match the authenticated Authority principal");
  }
}

/**
 * Build the live frame for one committed channel message.
 *
 * The message itself is framed by the shared builder, so a human reader sees
 * exactly what an Instance and a history read see. Only `clientMessageId` is
 * added here: it correlates the frame with the sender's optimistic row.
 */
export function humanChannelDeliveryFrame(
  input: HumanChannelLiveDeliveryInput,
  recipientUserId?: string,
): Extract<HumanServerMessage, { type: "channel_message_received" | "channel_message_updated" }> | undefined {
  const message = channelMessage(input);
  const recipients = (Array.isArray(input.recipientUserIds) ? input.recipientUserIds : [])
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  if (!message || recipients.length === 0) return undefined;
  if (input.deliveryKind === "update") {
    if (message.body !== "" || (!message.recalledAt && !message.deletedAt)) return undefined;
    return { type: "channel_message_updated", channelId: message.channelId, message };
  }
  const clientMessageId = typeof input.clientMessageId === "string"
    ? input.clientMessageId.trim()
    : "";
  const notification = recipientUserId
    ? input.recipientNotifications?.find((entry) => entry.userId === recipientUserId)?.notification
    : undefined;
  return {
    type: "channel_message_received",
    message,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(notification ? { notification } : {}),
  };
}

/**
 * Message fields come from the shared frame input, so a field the commit path
 * sends can never be missing from this type and silently dropped — which is what
 * happened to attachments, invisible to the compiler because the call site
 * builds this object with conditional spreads.
 */
export type HumanChannelLiveDeliveryInput = ChannelMessageFrameInput & {
  deliveryKind?: "update";
  recipientUserIds: string[];
  recipientNotifications?: Array<{
    userId: string;
    notification: import("@xmatrix/protocol").ChannelMessageNotification;
  }>;
  clientMessageId?: string;
};

export type HumanChannelLiveDeliveryResult = {
  matched: number;
  delivered: number;
};

/** The self-reported client fields of a refused connect, bounded for a log line. */
function refusedClient(device: unknown): Record<string, string> {
  if (!device || typeof device !== "object" || Array.isArray(device)) return {};
  const fields: Record<string, string> = {};
  for (const key of ["client", "version", "platform", "protocolVersion"] as const) {
    const value = (device as Record<string, unknown>)[key];
    if (typeof value === "string" || typeof value === "number") fields[key] = String(value).slice(0, 64);
  }
  return fields;
}
