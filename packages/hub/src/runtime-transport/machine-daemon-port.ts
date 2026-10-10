import { daemonClientCompatibility as machineDaemonCompatibility } from "../legacy-client-compatibility";
import {
  type MachineDaemonActivationReceipt,
  type MachineDaemonClientMessage,
  type MachineDaemonConnectMessage,
  type MachineDaemonServerMessage,
} from "@xmatrix/protocol/connections/machine-daemon";
import {
  CLIENT_UPGRADE_REQUIRED_CLOSE_CODE,
} from "@xmatrix/protocol";

import {
  MachineDaemonConnectionController,
  type MachineDaemonConnectionPort,
} from "../connections/machine-daemon/controller";
import { RuntimeClientOperationError } from "./runtime-operation-failure";
import { RuntimeSocketState } from "./ordered-socket-dispatch";
import {
  parseMachineDaemonHibernationAttachment,
  serializeMachineDaemonHibernationAttachment,
  type MachineDaemonHibernationAttachment,
} from "./machine-daemon-hibernation";
import { machineDaemonDeliverable } from "./machine-daemon-deliverable";

type Message<Type extends MachineDaemonClientMessage["type"]> = Extract<
  MachineDaemonClientMessage,
  { type: Type }
>;

type ExecutableMachineDaemonMessage = Exclude<
  MachineDaemonClientMessage,
  MachineDaemonConnectMessage | Message<"ping"> | Message<"refresh_auth">
>;

export const MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES = [
  "unregister",
  "machine_spawn_auth_required",
  "machine_spawn_result",
  "machine_run_exited",
  "machine_run_snapshot",
  "machine_stop_result",
  "machine_request_resolve_result",
  "machine_request_notice",
  "machine_worktree_cleanup_result",
  "machine_recover_reply_result",
  "machine_quota_probe_result",
  "machine_harness_action_result",
  "machine_worktree_action_result",
  "machine_text_task_result",
  "machine_command_admitted",
  "reverse_command_delivery",
  "disconnect",
] as const;

export type MachineDaemonAuthorityCapability =
  typeof MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES[number];

/** Close codes reserved for Machine Daemon route ownership changes. */
export const MACHINE_DAEMON_ROUTE_CLOSE = Object.freeze({
  replacedByConnect: Object.freeze({
    code: 4001,
    reason: "Replaced by a newer Machine Daemon connection",
  }),
  replacedByRehydrate: Object.freeze({
    code: 4001,
    reason: "Replaced by Machine Daemon route hibernation restore",
  }),
  selfHealedDuplicate: Object.freeze({
    code: 4002,
    reason: "Duplicate Machine Daemon route self-healed",
  }),
  failedDeliver: Object.freeze({
    code: 4003,
    reason: "Machine Daemon reverse delivery failed",
  }),
});

export interface MachineDaemonAuthorityPrincipal {
  ownerUserId: string;
  ownerEmail: string;
  machineId: string;
  hostId: string;
  hostName?: string;
  hostname?: string;
}

export interface MachineDaemonAuthorityAuthentication {
  principal: MachineDaemonAuthorityPrincipal;
  connected: Extract<MachineDaemonServerMessage, { type: "machine_daemon_connected" }>;
}

export interface MachineDaemonRuntimeSession {
  principal: MachineDaemonAuthorityPrincipal;
  connectionEpoch: number;
  displayName: string;
  clientVersion?: string;
  clientProtocolVersion?: number;
  capabilities: readonly string[];
  machineMetadata: Readonly<Record<string, unknown>>;
  connectedAt: string;
  lastSeenAt: string;
  /** Present only while a replacement daemon is fenced from route ownership. */
  activationPhase?: MachineDaemonActivationReceipt["phase"];
}

export interface MachineDaemonRouteIdentity {
  ownerUserId: string;
  machineId: string;
  hostId: string;
}

export interface MachineDaemonClaimWakeResult {
  /** Raw sockets matching the route before sole-owner healing. */
  matched: number;
  /** Commands successfully claimed and written to the sole live socket. */
  delivered: number;
  /** Always 0 or 1 after the route-ownership invariant is applied. */
  owners: number;
  /** True when more than one socket was found for the route and extras were closed. */
  healed: boolean;
  /** True when at least one command was written onto the sole live socket. */
  deliverable: boolean;
}

export interface MachineDaemonSocketBackend {
  readonly capabilities: ReadonlySet<MachineDaemonAuthorityCapability>;
  authenticate(message: MachineDaemonConnectMessage): Promise<MachineDaemonAuthorityAuthentication>;
  refresh(
    token: string,
    session: Readonly<MachineDaemonRuntimeSession>,
  ): Promise<MachineDaemonAuthorityPrincipal>;
  execute(
    session: Readonly<MachineDaemonRuntimeSession>,
    message: ExecutableMachineDaemonMessage,
  ): Promise<MachineDaemonServerMessage | readonly MachineDaemonServerMessage[] | undefined>;
  connected?(
    session: Readonly<MachineDaemonRuntimeSession>,
    deliver: (message: MachineDaemonServerMessage) => Promise<void>,
  ): void | Promise<void>;
  claimPending?(
    session: Readonly<MachineDaemonRuntimeSession>,
    deliver: (message: MachineDaemonServerMessage) => Promise<void>,
  ): Promise<number>;
  disconnected(
    session: Readonly<MachineDaemonRuntimeSession>,
    details: { code?: number; reason?: string; wasClean?: boolean },
  ): void | Promise<void>;
}

export class MachineDaemonAuthorityCapabilityError extends Error {
  readonly missingCapabilities: readonly MachineDaemonAuthorityCapability[];

  constructor(missingCapabilities: readonly MachineDaemonAuthorityCapability[]) {
    super(`Machine Daemon Authority port is missing required capabilities: ${missingCapabilities.join(", ")}`);
    this.name = "MachineDaemonAuthorityCapabilityError";
    this.missingCapabilities = missingCapabilities;
  }
}

type RouteCloseReason =
  | typeof MACHINE_DAEMON_ROUTE_CLOSE.replacedByConnect
  | typeof MACHINE_DAEMON_ROUTE_CLOSE.replacedByRehydrate
  | typeof MACHINE_DAEMON_ROUTE_CLOSE.selfHealedDuplicate
  | typeof MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver;

/**
 * Pure Authority composition for `/ws/machine-daemons`.
 *
 * Credential verification and Authority persistence are injected through one
 * domain-specific port. The transport owns only bounded frame dispatch and
 * ephemeral sessions; it has no RelayRoom fallback or storage authority.
 *
 * Invariant: at most one reverse-delivery owner per
 * `(ownerUserId, machineId)`. Connect, hibernation rehydrate, deliver,
 * and claim-wake all share that sole-owner rule so a zombie hibernated socket
 * cannot lease Authority commands away from the live daemon. Rehydration restores
 * route ownership only; it never starts background work inside the Runtime DO.
 */
export class MachineDaemonRuntimeTransport {
  readonly controller: MachineDaemonConnectionController;
  private readonly sockets: RuntimeSocketState<MachineDaemonRuntimeSession, MachineDaemonServerMessage>;
  private readonly backend: MachineDaemonSocketBackend;

  constructor(
    backend: MachineDaemonSocketBackend,
    private readonly allowLegacyProtocol = false,
    private readonly onConfirmedInstanceStop?: (instanceId: string) => void,
    /**
     * A route may have changed between reachable and unreachable. Presence
     * only: callers re-read {@link isRouteReachable}; nothing here is authority.
     */
    private readonly onRouteReachabilityChange?: (identity: MachineDaemonRouteIdentity) => void,
  ) {
    this.backend = backend;
    const missing = MACHINE_DAEMON_AUTHORITY_REQUIRED_CAPABILITIES.filter(
      (capability) => !backend.capabilities.has(capability),
    );
    if (missing.length > 0) throw new MachineDaemonAuthorityCapabilityError(missing);

    this.sockets = new RuntimeSocketState(
      "Machine Daemon",
      (requestId, message, failure) => ({ type: "error", requestId, message, ...(failure ? { failure } : {}) }),
      async (session, details) => {
        try {
          await this.backend.disconnected(session, details);
        } finally {
          this.routeReachabilityChanged(session.principal);
        }
      },
    );

    const port: MachineDaemonConnectionPort = {
      ...this.sockets.endpointPort(),
      connect: (ws, message) => this.sockets.ordered.schedule(this.connect(ws, message)),
      ping: (ws, requestId) => this.sockets.send(ws, {
        type: "pong", requestId, ts: new Date().toISOString(),
      }),
      refreshAuth: (ws, message) => this.sockets.ordered.schedule(this.refresh(ws, message)),
      unregister: (ws, requestId) => this.sockets.ordered.schedule(this.dispatch(ws, { type: "unregister", requestId })),
      reportSpawnAuthRequired: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportSpawnResult: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportRunExited: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportRunSnapshot: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportStopResult: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportRequestResolution: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportRequestNotice: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportReplyRecovery: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportQuotaProbe: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportHarnessAction: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportWorktreeAction: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportTextTask: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      reportWorktreeCleanup: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      renewCommandLease: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      admitCommand: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      beginActivation: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      prepareActivation: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
      advanceActivation: (ws, message) => this.sockets.ordered.schedule(this.dispatch(ws, message)),
    };
    this.controller = new MachineDaemonConnectionController(port);
  }

  handleFrame(ws: WebSocket, frame: string | ArrayBuffer): Promise<void> {
    return this.sockets.ordered.run(ws, () => this.controller.handleFrame(ws, frame));
  }

  /**
   * Reachability follows the exact live socket route. Silence is observational:
   * idle hibernated daemons do not need to wake Runtime to stay reachable.
   * Connect, close and delivery failure publish route changes to Instance views.
   * This is presence only; `data.machine_daemons` owns the durable route record.
   */
  isRouteReachable(identity: MachineDaemonRouteIdentity): boolean {
    for (const [ws, session] of this.sockets.entries()) {
      if (sameRouteIdentity(session.principal, identity) && isWebSocketOpen(ws)) return true;
    }
    return false;
  }

  private routeReachabilityChanged(identity: MachineDaemonRouteIdentity): void {
    if (!this.onRouteReachabilityChange) return;
    try {
      this.onRouteReachabilityChange({
        ownerUserId: identity.ownerUserId,
        machineId: identity.machineId,
        hostId: identity.hostId,
      });
    } catch (error) {
      // Presence fanout must never fail the daemon frame or close that caused it.
      console.error("Machine Daemon reachability fanout failed", error);
    }
  }
  accept(ws: WebSocket): void { this.controller.socket.accept(ws); }
  session(ws: WebSocket): Readonly<MachineDaemonRuntimeSession> | undefined {
    return this.sockets.get(ws);
  }
  hibernationAttachment(ws: WebSocket): MachineDaemonHibernationAttachment | undefined {
    const session = this.sockets.get(ws);
    return session && !session.activationPhase
      ? serializeMachineDaemonHibernationAttachment(session)
      : undefined;
  }

  /**
   * Restore a hibernated session as the sole reverse-delivery owner for its
   * machine route. Sibling hibernated sockets for the same route are closed
   * without Authority unregister so they cannot re-lease spawn intents.
   *
   * When a newer owner is already restored, the incoming older attachment is
   * discarded (attachment order from `getWebSockets()` is not trusted).
   */
  rehydrate(ws: WebSocket, value: unknown): boolean {
    const attachment = parseMachineDaemonHibernationAttachment(value);
    if (!attachment) return false;
    if (!machineDaemonCompatibility(
      attachment.session.clientVersion,
      attachment.session.clientProtocolVersion,
      this.allowLegacyProtocol,
    ).compatible) {
      ws.close(CLIENT_UPGRADE_REQUIRED_CLOSE_CODE, "Client upgrade required");
      return true;
    }
    const peers = [...this.sockets.entries()].filter(([socket, session]) =>
      socket !== ws && sameRouteIdentity(session.principal, attachment.session.principal)
    );
    const newestPeer = peers
      .map(([, session]) => session)
      .sort((left, right) => compareRouteRecency(right, left))[0];
    if (newestPeer && compareRouteRecency(newestPeer, attachment.session) > 0) {
      // Already restored a fresher owner for this route — drop the zombie.
      this.evictRouteSocket(ws, MACHINE_DAEMON_ROUTE_CLOSE.replacedByRehydrate);
      return true;
    }
    this.installSoleRouteOwner(
      ws,
      attachment.session,
      MACHINE_DAEMON_ROUTE_CLOSE.replacedByRehydrate,
    );
    this.sockets.restore(ws, attachment.session);
    return true;
  }

  handleClose(
    ws: WebSocket,
    code?: number,
    reason?: string,
    wasClean?: boolean,
  ): Promise<void> {
    return this.sockets.ordered.run(
      ws,
      () => this.controller.socket.handleClose(ws, code, reason, wasClean),
      false,
    );
  }

  /**
   * Authority-owned reverse commands use the sole enrolled machine owner.
   * The send joins the same per-socket queue as inbound frames so a command
   * cannot overtake handshake, refresh, unregister, or close processing.
   */
  async deliver(
    identity: MachineDaemonRouteIdentity,
    message: MachineDaemonServerMessage,
  ): Promise<number> {
    const route = this.resolveSoleRoute(identity);
    if (!route.owner) return 0;
    const [ws, session] = route.owner;
    await this.sockets.ordered.enqueue(ws, async () => {
      if (this.sockets.get(ws) !== session) return;
      this.sockets.send(ws, message);
    }, true);
    return this.sockets.get(ws) === session ? 1 : 0;
  }

  /**
   * Claim pending Authority commands for the sole live owner of this machine route.
   * Duplicate sockets are healed before claim so only one lease owner exists.
   */
  async claimPending(identity: MachineDaemonRouteIdentity): Promise<MachineDaemonClaimWakeResult> {
    const route = this.resolveSoleRoute(identity);
    if (route.healed) {
      console.error("Machine Daemon route ownership self-healed before claim", {
        ownerUserId: identity.ownerUserId,
        machineId: identity.machineId,
        hostId: identity.hostId,
        matched: route.matched,
      });
    }
    if (!route.owner || !this.backend.claimPending) {
      return claimWakeResult({
        matched: route.matched,
        delivered: 0,
        owners: 0,
        healed: route.healed,
      });
    }
    const [ws, session] = route.owner;
    // Half-open sockets can still appear in ownership maps while the live
    // daemon cannot read frames. Evict before leasing so reconnect catch-up
    // can rebind. Failed send is the same eviction: one truth, then reconnect.
    if (!isWebSocketOpen(ws)) {
      this.evictRouteSocket(ws, MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver);
      return claimWakeResult({
        matched: route.matched,
        delivered: 0,
        owners: 0,
        healed: true,
      });
    }
    let delivered = 0;
    try {
      await this.sockets.ordered.enqueue(ws, async () => {
        if (this.sockets.get(ws) !== session || !this.backend.claimPending) return;
        if (!isWebSocketOpen(ws)) {
          this.evictRouteSocket(ws, MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver);
          return;
        }
        delivered = await this.backend.claimPending(session, async (message) => {
          if (this.sockets.get(ws) !== session || !isWebSocketOpen(ws)) {
            throw new Error("Machine Daemon pending-command delivery binding is stale");
          }
          this.sendForSession(ws, session, message);
        });
        if (delivered > 0) session.lastSeenAt = new Date().toISOString();
      }, true);
    } catch {
      this.evictRouteSocket(ws, MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver);
      return claimWakeResult({
        matched: route.matched,
        delivered: 0,
        owners: 0,
        healed: true,
      });
    }
    return claimWakeResult({
      matched: route.matched,
      delivered,
      owners: this.sockets.get(ws) === session ? 1 : 0,
      healed: route.healed,
    });
  }

  private async connect(ws: WebSocket, message: MachineDaemonConnectMessage): Promise<void> {
    const compatibility = machineDaemonCompatibility(
      message.clientVersion,
      message.protocolVersion,
      this.allowLegacyProtocol,
    );
    if (!compatibility.compatible) {
      const upgradeMessage = compatibility.error ?? "Client upgrade required";
      const rejection = { type: "error" as const, requestId: message.requestId, message: upgradeMessage };
      this.sockets.send(ws, rejection);
      this.sockets.remove(ws);
      ws.close(CLIENT_UPGRADE_REQUIRED_CLOSE_CODE, "Client upgrade required");
      return;
    }
    await this.sockets.answerOperation(ws, message.requestId, "Workstation request could not be completed", async () => {
      const authentication = await this.backend.authenticate(message);
      assertMachineBinding(message, authentication);
      const now = new Date().toISOString();
      const session: MachineDaemonRuntimeSession = {
        principal: authentication.principal,
        connectionEpoch: authentication.connected.connectionEpoch,
        displayName: message.displayName.trim(),
        clientVersion: cleanOptional(message.clientVersion),
        clientProtocolVersion: message.protocolVersion,
        capabilities: cleanCapabilities(message.capabilities),
        machineMetadata: cleanMetadata(message.machineMetadata),
        lastSeenAt: now,
        connectedAt: now,
        ...(authentication.connected.activation &&
          authentication.connected.activation.phase !== "stable_granted"
          ? { activationPhase: authentication.connected.activation.phase }
          : {}),
      };
      this.sockets.establish(ws, session, authentication.connected);
      this.routeReachabilityChanged(session.principal);
      if (!session.activationPhase) {
        // A normal authenticated connection owns the route immediately. A
        // recovering candidate stays invisible until StableGranted.
        this.installSoleRouteOwner(ws, session, MACHINE_DAEMON_ROUTE_CLOSE.replacedByConnect);
        await this.catchUpReverseDelivery(ws, session);
      }
    });
  }

  private async dispatch(ws: WebSocket, message: ExecutableMachineDaemonMessage): Promise<void> {
    const requestId = "requestId" in message ? message.requestId : undefined;
    await this.sockets.authenticatedOperation(ws, requestId, "Machine Daemon", "Workstation request could not be completed", async (session) => {
      const activationMessage = message.type === "machine_activation_prepare" ||
        message.type === "machine_activation_advance";
      if (session.activationPhase && !activationMessage) {
        throw new RuntimeClientOperationError("machine_activation_fenced");
      }
      if (!session.activationPhase && activationMessage) {
        throw new RuntimeClientOperationError("machine_activation_context_required");
      }
      const output = await this.backend.execute(session, message);
      this.sockets.sendOutput(ws, output);
      const receipt = activationReceiptFromOutput(output);
      if (receipt) session.activationPhase = receipt.phase;
      if (receipt?.phase === "stable_granted") {
        session.activationPhase = undefined;
        this.installSoleRouteOwner(ws, session, MACHINE_DAEMON_ROUTE_CLOSE.replacedByConnect);
        await this.catchUpReverseDelivery(ws, session);
      }
      if (receipt?.phase === "aborted") {
        session.activationPhase = undefined;
        this.installSoleRouteOwner(ws, session, MACHINE_DAEMON_ROUTE_CLOSE.replacedByConnect);
        await this.catchUpReverseDelivery(ws, session);
      }
      if (message.type === "unregister") this.sockets.remove(ws);
      else if (
        !session.activationPhase &&
        (message.type === "machine_run_exited" ||
          message.type === "machine_stop_result" ||
          message.type === "machine_run_snapshot" && message.snapshotComplete === true)
      ) {
        // These reports can issue Channel About successors (a partial snapshot
        // only records progress and never does). Claiming on this
        // same frame avoids a Runtime→Runtime wake fetch that would deadlock
        // the isolate. Activation and other inbound frames must not catch-up
        // here: StableGranted already does that once.
        await this.catchUpReverseDelivery(ws, session);
      }
      if (
        message.type === "machine_stop_result" &&
        message.ok === true &&
        typeof message.instanceId === "string" &&
        message.instanceId.trim()
      ) {
        this.onConfirmedInstanceStop?.(message.instanceId.trim());
      }
    });
  }

  private async refresh(ws: WebSocket, message: Message<"refresh_auth">): Promise<void> {
    await this.sockets.authenticatedOperation(ws, message.requestId, "Machine Daemon", "Workstation request could not be completed", async (session) => {
      const principal = await this.backend.refresh(message.token, session);
      assertSamePrincipal(session.principal, principal);
      session.principal = { ...principal, hostId: session.principal.hostId, hostName: session.principal.hostName };
      this.sockets.authenticationRefreshed(ws, session,
        (ts) => ({ type: "auth_refreshed", requestId: message.requestId, ts }));
    });
  }

  /** Perform the single catch-up claim attached to a fresh authenticated connect. */
  private async catchUpReverseDelivery(
    ws: WebSocket,
    session: MachineDaemonRuntimeSession,
  ): Promise<void> {
    // Connect already runs inside this socket's ordered frame. Enqueuing the
    // delivery behind that same frame would deadlock it while awaiting itself.
    await this.backend.connected?.(session, async (message) => this.sendForSession(ws, session, message));
  }

  private sendForSession(ws: WebSocket, session: Readonly<MachineDaemonRuntimeSession>, message: MachineDaemonServerMessage): void {
    if (this.sockets.get(ws) !== session || !isWebSocketOpen(ws)) {
      throw new RuntimeClientOperationError("machine_delivery_binding_stale");
    }
    this.sockets.send(ws, message);
  }

  /**
   * Close every other authenticated socket for the same control-plane route.
   * Does not call Authority disconnect: the route remains enrolled under the
   * surviving owner. `remove` before `close` so the late close callback does
   * not unregister the live principal.
   */
  private installSoleRouteOwner(
    keep: WebSocket,
    session: Readonly<MachineDaemonRuntimeSession>,
    close: RouteCloseReason,
  ): void {
    for (const [existingSocket, existingSession] of Array.from(this.sockets.entries())) {
      if (existingSocket === keep) continue;
      if (!sameRouteIdentity(existingSession.principal, session.principal)) continue;
      this.evictRouteSocket(existingSocket, close);
    }
  }

  /**
   * Resolve the single reverse-delivery owner for a route. If duplicates
   * still exist (for example from a race between rehydrate and connect), keep
   * the most recently seen session and close the rest before any claim.
   */
  private resolveSoleRoute(identity: MachineDaemonRouteIdentity): {
    matched: number;
    healed: boolean;
    owner?: [WebSocket, MachineDaemonRuntimeSession];
  } {
    const candidates = [...this.sockets.entries()].filter(([, session]) =>
      !session.activationPhase && sameRouteIdentity(session.principal, identity)
    );
    if (candidates.length === 0) {
      return { matched: 0, healed: false };
    }
    if (candidates.length === 1) {
      return { matched: 1, healed: false, owner: candidates[0] };
    }
    candidates.sort((left, right) => compareRouteRecency(right[1], left[1]));
    const winner = candidates[0]!;
    for (const [socket] of candidates.slice(1)) {
      this.evictRouteSocket(socket, MACHINE_DAEMON_ROUTE_CLOSE.selfHealedDuplicate);
    }
    return {
      matched: candidates.length,
      healed: true,
      owner: this.sockets.get(winner[0]) === winner[1] ? winner : undefined,
    };
  }

  private evictRouteSocket(ws: WebSocket, close: RouteCloseReason): void {
    const session = this.sockets.get(ws);
    this.sockets.remove(ws);
    try {
      // Drop hibernation attachment so a later DO wake cannot resurrect this
      // zombie as a second claimer for the same machine route.
      ws.serializeAttachment?.(null);
    } catch {
      // Attachment clearing is best-effort; close still demotes the socket.
    }
    ws.close(close.code, close.reason);
    // remove() before close so a late close cannot unregister a surviving
    // owner. That also means handleClose finds no session and never persists
    // offline. A failedDeliver eviction of the last owner must persist, or
    // catalog stays hollow-online while reverse delivery is gone.
    if (
      session &&
      shouldPersistMachineDaemonOfflineAfterEvict(close, this.remainingRouteOwners(session.principal))
    ) {
      void this.backend.disconnected(session, {
        code: close.code,
        reason: close.reason,
        wasClean: false,
      });
      this.routeReachabilityChanged(session.principal);
    }
  }

  private remainingRouteOwners(identity: MachineDaemonRouteIdentity): number {
    let owners = 0;
    for (const [, owner] of this.sockets.entries()) {
      if (!owner.activationPhase && sameRouteIdentity(owner.principal, identity)) owners += 1;
    }
    return owners;
  }
}

export function shouldPersistMachineDaemonOfflineAfterEvict(
  close: { code: number },
  remainingOwners: number,
): boolean {
  return close.code === MACHINE_DAEMON_ROUTE_CLOSE.failedDeliver.code && remainingOwners === 0;
}

function activationReceiptFromOutput(
  output: MachineDaemonServerMessage | readonly MachineDaemonServerMessage[] | undefined,
): MachineDaemonActivationReceipt | undefined {
  const messages = output === undefined ? [] : Array.isArray(output) ? output : [output];
  return messages.find((message) => message.type === "machine_activation_receipt") as
    MachineDaemonActivationReceipt | undefined;
}

export { machineDaemonCompatibility };

function compareRouteRecency(
  left: Readonly<MachineDaemonRuntimeSession>,
  right: Readonly<MachineDaemonRuntimeSession>,
): number {
  const leftSeen = Date.parse(left.lastSeenAt) || 0;
  const rightSeen = Date.parse(right.lastSeenAt) || 0;
  if (leftSeen !== rightSeen) return leftSeen - rightSeen;
  const leftConnected = Date.parse(left.connectedAt) || 0;
  const rightConnected = Date.parse(right.connectedAt) || 0;
  return leftConnected - rightConnected;
}

/** Cloudflare and browser WebSockets both expose readyState; OPEN === 1. */
function isWebSocketOpen(ws: WebSocket): boolean {
  const state = (ws as { readyState?: number }).readyState;
  return state === undefined || state === 1;
}

function assertMachineBinding(
  message: MachineDaemonConnectMessage,
  authentication: MachineDaemonAuthorityAuthentication,
): void {
  const principal = authentication.principal;
  const daemon = authentication.connected.daemon;
  if (!message.token.trim() || !message.displayName.trim() ||
      message.machineId.trim() !== principal.machineId ||
      daemon.userId !== principal.ownerUserId || daemon.email !== principal.ownerEmail ||
      daemon.machineId !== principal.machineId) {
    throw new RuntimeClientOperationError("machine_credential_mismatch");
  }
}

function assertSamePrincipal(
  expected: MachineDaemonAuthorityPrincipal,
  actual: MachineDaemonAuthorityPrincipal,
): void {
  if (!sameRouteIdentity(expected, actual)) {
    throw new RuntimeClientOperationError("machine_credential_mismatch");
  }
}

export function sameRouteIdentity(
  left: MachineDaemonRouteIdentity,
  right: MachineDaemonRouteIdentity,
): boolean {
  return left.ownerUserId === right.ownerUserId &&
    left.machineId === right.machineId;
}

/** Map key for per-route state; equal exactly when `sameRouteIdentity` holds. */
export function machineDaemonRouteKey(identity: MachineDaemonRouteIdentity): string {
  return JSON.stringify([identity.ownerUserId, identity.machineId]);
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean || undefined;
}

function cleanCapabilities(value: readonly string[] | undefined): readonly string[] {
  return Object.freeze(Array.from(new Set(
    (value ?? []).map((item) => item.trim()).filter(Boolean),
  )).sort());
}

function cleanMetadata(value: Record<string, unknown> | undefined): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...value });
}

function claimWakeResult(
  result: Omit<MachineDaemonClaimWakeResult, "deliverable">,
): MachineDaemonClaimWakeResult {
  return {
    ...result,
    deliverable: machineDaemonDeliverable(result),
  };
}
