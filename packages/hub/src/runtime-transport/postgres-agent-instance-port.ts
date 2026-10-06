import { RuntimeClientOperationError } from "./runtime-operation-failure";
import type {
  AgentInstanceClientMessage,
  AgentInstanceConnectMessage,
  AgentInstanceServerMessage,
} from "@xmatrix/protocol/connections/agent-instance";
import type { LiveAgentStatus, SerializedAgent } from "@xmatrix/protocol";
import {
  callerMessageMetadata,
  ChannelActivityInvalid,
  CHANNEL_ACTIVITY_MESSAGE_KIND,
  CHANNEL_ACTIVITY_PROVENANCE,
  channelActivityLine,
  isAgentUsageLimitLifecycle,
  isLiveAgentStatus,
  normalizeChannelActivity,
} from "@xmatrix/protocol";

import { verifyAuthToken, type AgentRunPrincipal, type AuthUser } from "../auth";
import { relayRuntimeCellsForOwners } from "../relay-authority-locator";
import type { Env } from "../types";
import {
  AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES,
  AgentInstanceReconnectRequiredError,
  type AgentInstanceAuthorityAuthentication,
  type AgentInstanceAuthorityRunBinding,
  type AgentInstanceControlSwitchBinding,
  type AgentInstanceControlSwitchResult,
  type AgentInstanceSocketBackend,
  type AgentInstanceRunPrincipal,
  type AgentInstanceRuntimeSession,
} from "./agent-instance-port";
import {
  runtimeMessages,
  recordValue,
  runtimeCommandId,
  runtimeVersionedCommandId,
  type RuntimeMessages,
} from "./runtime-messages";
import { agentInstanceUnregisterIsTerminal } from "./agent-instance-unregister";
import { productAgentSystemNoticeSenderSnapshot } from "../product-agent-mention-authority-adapter";
import { LIVE_RUN_ROUTED_FIELDS, liveRunIsAdmitted, snapshotLiveRunFromProductGateway } from "../live-run-admission";
import {
  agentMessagePresentation,
  agentSummaryPresentation,
  initialAgentInstancePresentation,
  mergeAgentInstancePresentation,
  sanitizeAgentInstancePresentation,
  type AgentInstancePresentation,
} from "./agent-instance-presentation";
import { queryAgentInstanceRun, type AgentInstanceRuntime } from "./agent-instance-run-query";
import {
  agentInstancePresenceCommand,
} from "./agent-instance-presence-command";
import { recordAgentLaunchStage } from "../postgres-observability";
import {
  agentTurnFailureAppendCommand,
  shouldPersistAgentTurnFailureNotice,
} from "./agent-turn-failure-notice";
import {
  usageLimitHandoffCommand,
  usageLimitHandoffIds,
} from "./agent-usage-limit-handoff";
import { getSpaceManagementConfig } from "../spaces";
import { recordInstancePresentation, runtimeRepository } from "../runtime";
import { holdRegistrationUsageLimit } from "../registration-launch-dispatch";

type Message<Type extends AgentInstanceClientMessage["type"]> = Extract<
  AgentInstanceClientMessage,
  { type: Type }
>;
type PortMessage = Exclude<
  AgentInstanceClientMessage,
  AgentInstanceConnectMessage | Message<"ping"> | Message<"refresh_auth">
>;
type HistoryMessage = Message<"join_channel"> | Message<"leave_channel"> |
  Message<"replay_channel_history"> | Message<"get_channel_history">;
type RuntimeSignalMessage = Exclude<
  PortMessage,
  HistoryMessage | Message<"unregister"> | Message<"channel_message"> | Message<"channel_activity"> |
  Message<"channel_message_ack">
>;
type AuthorityOutput = AgentInstanceServerMessage | readonly AgentInstanceServerMessage[] | undefined;

/**
 * Client message types accepted beyond the original protocol, advertised on
 * connect: a Hub closes the socket on an unknown type, so a newer runtime
 * sends one only when its Hub lists it.
 */
export const AGENT_INSTANCE_HUB_CAPABILITIES = ["channel_activity"] as const;

/** Channel history for an Agent Instance socket: join, leave, catch-up replay and paged reads. */
export interface AgentChannelHistoryPort {
  join(session: Readonly<AgentInstanceRuntimeSession>, message: Message<"join_channel">): Promise<AuthorityOutput>;
  leave(session: Readonly<AgentInstanceRuntimeSession>, message: Message<"leave_channel">): Promise<AuthorityOutput>;
  replay(session: Readonly<AgentInstanceRuntimeSession>, message: Message<"replay_channel_history">): Promise<AuthorityOutput>;
  history(session: Readonly<AgentInstanceRuntimeSession>, message: Message<"get_channel_history">): Promise<AuthorityOutput>;
}

/** Bounded live/runtime telemetry sink for signals that are not product authority. */
export interface AgentInstanceRuntimeSignalsPort {
  publish(session: Readonly<AgentInstanceRuntimeSession>, message: RuntimeSignalMessage): Promise<AuthorityOutput>;
  /** Rendezvous for a live model/effort switch and the Instance result frame. */
  awaitControlResult?(
    binding: AgentInstanceControlSwitchBinding,
    timeoutMs: number,
  ): Promise<AgentInstanceControlSwitchResult>;
  connected?(
    session: Readonly<AgentInstanceRuntimeSession>,
    deliver: (message: AgentInstanceServerMessage) => Promise<void>,
  ): void | Promise<void>;
  disconnected?(session: Readonly<AgentInstanceRuntimeSession>): void | Promise<void>;
}

export interface PostgresAgentInstancePortDependencies {
  authenticate(token: string): Promise<AuthUser>;
  messages: RuntimeMessages;
  runtime: AgentInstanceRuntime;
  /** A Space's management configuration and its generation, as its owner reads it. */
  managementConfig(spaceId: string, ownerUserId: string): Promise<{
    managementAgent: Record<string, unknown>; version: number;
  }>;
  history: AgentChannelHistoryPort;
  signals: AgentInstanceRuntimeSignalsPort;
  /** Runtime cells of a Human, for Human-visible join_birth metrics (Room emitObservabilityEvent). */
  runtimeCells?(ownerUserId: string): readonly { fetch(request: Request): Promise<Response> }[];
  atomicInstanceConnect?: boolean;
  /** Keep work alive past the socket operation that started it. */
  runInBackground?(task: Promise<unknown>): void;
  observeAgentLaunchStage?(stage: string, outcome: "ok" | "error", durationMs: number): void;
}

export class PostgresAgentInstancePort implements AgentInstanceSocketBackend {
  readonly capabilities = new Set(AGENT_INSTANCE_AUTHORITY_REQUIRED_CAPABILITIES);

  static fromEnv(input: {
    env: Env;
    history: AgentChannelHistoryPort;
    signals: AgentInstanceRuntimeSignalsPort;
    scheduleBackground?: (task: Promise<unknown>) => void;
    runtimeSelf?: { cellName: () => string; fetch(request: Request): Promise<Response> };
    /** The Run and Instance facts the socket reads and changes; PostgreSQL by default. */
    runtime?: AgentInstanceRuntime;
  }): PostgresAgentInstancePort {
    return new PostgresAgentInstancePort({
      authenticate: (token) => verifyAuthToken(token, input.env),
      messages: runtimeMessages(
        input.env,
        input.scheduleBackground,
        input.runtimeSelf,
      ),
      runtime: input.runtime ?? {
        getRun: ({ runId, ownerUserId }) => runtimeRepository(input.env).getRun({
          requestId: crypto.randomUUID(), runId, actorUserId: ownerUserId }),
        transition: (command) => command.kind === "instance_presentation"
          ? recordInstancePresentation(input.env, {
            commandId: String(command.commandId), actorUserId: String(command.actorUserId),
            spaceId: String(command.spaceId), instanceId: String(command.instanceId),
            presentation: (command.presentation ?? null) as Record<string, unknown> | null,
            ...(typeof command.status === "string" ? { status: command.status } : {}),
            at: String(command.at) })
          : runtimeRepository(input.env).mutate(command),
        holdUsageLimit: (hold) => holdRegistrationUsageLimit(input.env, hold),
      },
      managementConfig: (spaceId, ownerUserId) => getSpaceManagementConfig(input.env, {
        spaceId, principal: { kind: "user", id: ownerUserId },
      }),
      history: input.history,
      signals: input.signals,
      atomicInstanceConnect: true,
      ...(input.scheduleBackground ? { runInBackground: input.scheduleBackground } : {}),
      observeAgentLaunchStage: (stage, outcome, durationMs) => recordAgentLaunchStage({
        env: input.env, stage, outcome, durationMs,
      }),
      ...(input.env.RELAY_RUNTIME
        ? { runtimeCells: (ownerUserId: string) => relayRuntimeCellsForOwners(input.env, [ownerUserId]) }
        : {}),
    });
  }

  /** Last presentation persisted per Instance by this cell, to keep the write
   *  edge-triggered instead of firing on every presence update. */
  private readonly persistedPresentationDigests = new Map<string, string>();

  constructor(private readonly dependencies: PostgresAgentInstancePortDependencies) {
    requireMethods(dependencies.history, ["join", "leave", "replay", "history"], "AgentChannelHistoryPort");
    requireMethods(dependencies.signals, ["publish"], "AgentInstanceRuntimeSignalsPort");
  }

  awaitControlResult(
    binding: AgentInstanceControlSwitchBinding,
    timeoutMs: number,
  ): Promise<AgentInstanceControlSwitchResult> {
    const await_ = this.dependencies.signals.awaitControlResult;
    if (!await_) {
      return Promise.reject(new Error("This Runtime signal composition cannot await control results"));
    }
    return await_.call(this.dependencies.signals, binding, timeoutMs);
  }

  async authenticate(message: AgentInstanceConnectMessage): Promise<AgentInstanceAuthorityAuthentication> {
    const binding = await this.authenticationBinding(message.token, message);
    return {
      principal: binding.principal,
      run: binding.run,
      ...(binding.presentation ? { presentation: binding.presentation } : {}),
      connected: {
        type: "agent_instance_connected",
        agent: connectedAgent(
          binding.user,
          binding.principal,
          binding.run,
          message,
          binding.presentation,
        ),
        peers: [],
        hubCapabilities: [...AGENT_INSTANCE_HUB_CAPABILITIES],
      },
    };
  }

  async refresh(token: string, session: Readonly<AgentInstanceRuntimeSession>): Promise<AgentInstanceRunPrincipal> {
    return (await this.authenticationBinding(token, undefined, session)).principal;
  }

  async execute(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: PortMessage,
  ): Promise<AuthorityOutput> {
    assertBoundChannel(session, message);
    if (session.run.kind === "channel-about-session") {
      if (message.type === "channel_message" || message.type === "channel_activity") {
        throw new RuntimeClientOperationError("agent_read_only_session");
      }
      if (message.type === "channel_message_ack" ||
          message.type === "presence_update" ||
          message.type === "agent_model_switch_result" ||
          message.type === "agent_effort_switch_result" ||
          message.type === "agent_lifecycle" ||
          message.type === "client_network_sample" ||
          message.type === "event_publish") {
        return undefined;
      }
    }
    switch (message.type) {
      case "join_channel": {
        const result = await this.dependencies.history.join(session, message);
        await this.emitJoinBirthMetric(session, message, result);
        return result;
      }
      case "leave_channel": return this.dependencies.history.leave(session, message);
      case "replay_channel_history": {
        const result = await this.dependencies.history.replay(session, message);
        await this.emitReplayMetric(session, message, result);
        return result;
      }
      case "get_channel_history": return this.dependencies.history.history(session, message);
      case "channel_message": return this.appendMessage(session, message);
      case "channel_activity": return this.appendActivity(session, message);
      case "channel_message_ack": return this.acknowledgeMessage(session, message);
      case "unregister": return this.unregister(session, message.requestId);
      case "event_publish":
        // The exact Agent host retains LLM traces. Human trace detail reads
        // call that host directly, so Runtime never stores or forwards them.
        if (message.eventType === "llm_trace") return undefined;
        return this.dependencies.signals.publish(session, message);
      case "agent_lifecycle": {
        const published = await this.dependencies.signals.publish(session, message);
        await this.persistTurnFailureNotice(session, message);
        return published;
      }
      case "presence_update": {
        // The transport merges this into the session after `execute` returns,
        // so resolve the next presentation here rather than reading a stale one.
        const output = await this.dependencies.signals.publish(session, message);
        await this.persistInstancePresentation(
          session,
          mergeAgentInstancePresentation(session.presentation, message),
          Object.prototype.hasOwnProperty.call(message, "models"),
          Object.prototype.hasOwnProperty.call(message, "parameters"),
          isLiveAgentStatus(message.status) ? message.status : session.run.instanceStatus,
        );
        return output;
      }
      default: return this.dependencies.signals.publish(session, message);
    }
  }

  /**
   * Give the send-time presentation a durable home on the Instance row.
   *
   * This exists because the two Agent send paths are not symmetric. A message
   * sent over this WebSocket stamps its header from `session.presentation` for
   * free, because it runs inside the cell that holds the session. The REST send
   * path runs in the Worker, holds no session, and could only learn the same
   * facts by calling this single global cell on every message. Writing the row
   * here -- on the edge, when the header's own five fields change -- lets the
   * append transaction read them from a row it already locks.
   *
   * `presence_update` is the only trigger. Registration is a fenced critical
   * path that reports its own failing phase, so a display-state write must not
   * be able to fail it; until the first presence update lands, the caller's own
   * overlay still carries the header.
   *
   * The live status (online, busy or idle) rides the same write. The row is
   * what a catalog snapshot, a page load and a reconnecting Web read, ordered
   * against live frames by its `updated_at`; a row that advanced that clock
   * while still saying `online` turned every busy Instance idle on the next
   * snapshot.
   *
   * The digest is per connection and deliberately not persisted: the connect
   * writes `online` to the row, so the replayed presence that follows every
   * reconnect, Hub deploy or not, must persist again.
   */
  private async persistInstancePresentation(
    session: Readonly<AgentInstanceRuntimeSession>,
    presentation: AgentInstancePresentation | undefined,
    catalogReported = false,
    parametersReported = false,
    status?: string,
  ): Promise<void> {
    if (!this.dependencies.atomicInstanceConnect) return;
    if (session.run.kind !== "channel-instance") return;
    const instanceId = session.run.instanceId;
    // Routing reads provider observations from this Instance row. Message
    // headers intentionally omit usage, so their projection is insufficient
    // for persistence (and would deduplicate quota-only updates away).
    const canonical = sanitizeAgentInstancePresentation(presentation);
    const usage = canonical?.usage;
    const snapshot = {
      ...agentMessagePresentation(canonical),
      ...(canonical?.parameters !== undefined ? { parameters: canonical.parameters, parametersObservedAt: canonical.parametersObservedAt } : parametersReported ? { parameters: [] } : {}),
      // Routing needs the observed model/effort domain too. It is deliberately
      // absent from message headers, but must survive this durable projection.
      ...(canonical?.models?.length && canonical.modelsObservedAt ? {
        models: canonical.models, modelsObservedAt: canonical.modelsObservedAt,
      } : catalogReported ? { models: [] } : {}),
      ...(usage ? { usage } : {}),
    };
    const liveStatus = isLiveAgentStatus(status) ? status : undefined;
    const digest = JSON.stringify([liveStatus ?? null, snapshot]);
    if (this.persistedPresentationDigests.get(instanceId) === digest) return;
    const at = new Date().toISOString();
    await this.dependencies.runtime.transition({
      commandId: runtimeCommandId("agent-instance-presentation", `${instanceId}:${at}`),
      kind: "instance_presentation",
      actorUserId: session.principal.ownerUserId,
      spaceId: session.principal.spaceId,
      channelId: session.principal.channelId,
      instanceId,
      presentation: snapshot,
      ...(liveStatus ? { status: liveStatus } : {}),
      at,
    });
    this.persistedPresentationDigests.set(instanceId, digest);
  }

  async disconnected(session: Readonly<AgentInstanceRuntimeSession>): Promise<void> {
    if (session.run.kind === "channel-about-session" ||
        session.run.channelDeliveryEnabled === false) return;
    // Drop this connection's ephemeral state before awaiting the database. A
    // successor may register while its predecessor's offline CAS is in flight.
    this.persistedPresentationDigests.delete(session.run.instanceId);
    await this.dependencies.signals.disconnected?.(session);
    try {
      await this.persistTransportOffline(session);
    } catch {
      // Live fanout must still drop. Reconnect or unregister recovers Authority
      // if this transport-close write lost the race.
    }
  }

  private async persistTransportOffline(
    session: Readonly<AgentInstanceRuntimeSession>,
  ): Promise<void> {
    // Never borrow the current row's version: it may belong to a successor.
    // Attachments predating connection fencing only clear ephemeral presence;
    // their next authenticated connect obtains a durable connection version.
    const expectedVersion = session.run.connectionVersion;
    if (expectedVersion === undefined) return;
    await this.dependencies.runtime.transition(agentInstancePresenceCommand({
      atomicInstanceConnect: false,
      commandId: runtimeVersionedCommandId(
        "agent-transport-offline",
        session.run.instanceId,
        expectedVersion,
      ),
      principal: session.principal,
      instanceId: session.run.instanceId,
      expectedVersion,
      at: new Date().toISOString(),
      status: "offline",
    }));
  }

  connected(
    session: Readonly<AgentInstanceRuntimeSession>,
    deliver: (message: AgentInstanceServerMessage) => Promise<void>,
  ): void | Promise<void> {
    if (session.run.kind === "channel-about-session" ||
        session.run.channelDeliveryEnabled === false) return;
    // Presentation is deliberately not written here. Registration is a fenced
    // critical path that reports its own failing phase, and a display-state
    // write has no business being able to fail it or to slow it by a round
    // trip. The first presence update persists it instead, so forget what an
    // earlier connection of this Instance wrote: the connect reset the row.
    this.persistedPresentationDigests.delete(session.run.instanceId);
    return this.dependencies.signals.connected?.(session, deliver);
  }

  private async authenticationBinding(
    token: string,
    connectMessage?: AgentInstanceConnectMessage,
    refreshSession?: Readonly<AgentInstanceRuntimeSession>,
  ): Promise<{
    user: AuthUser;
    principal: AgentInstanceRunPrincipal;
    run: AgentInstanceAuthorityRunBinding;
    presentation?: AgentInstancePresentation;
  }> {
    const user = await this.dependencies.authenticate(token);
    if (!user.agentRun) throw new RuntimeClientOperationError("agent_run_credential_required");
    const principal = runPrincipal(user.agentRun);
    const response = await queryAgentInstanceRun(this.dependencies.runtime, {
      runId: principal.runId,
      ownerUserId: principal.ownerUserId,
    });
    const value = recordValue(response.run, "run");
    const metadata = recordValue(value.metadata, "run.metadata");
    liveRunStatus(value.status);
    if (!liveRunIsAdmitted(snapshotLiveRunFromProductGateway(value), principal, LIVE_RUN_ROUTED_FIELDS)) {
      throw new RuntimeClientOperationError("agent_run_binding_mismatch");
    }
    if (
      metadata.routedAs === "management_assistant_mention" ||
      metadata.routedAs === "management_channel_about"
    ) {
      const managementSpaceId = requiredString(
        metadata.managementSpaceId,
        "run.metadata.managementSpaceId",
      );
      const configGeneration = requiredNonnegativeInteger(
        metadata.managementConfigGeneration,
        "run.metadata.managementConfigGeneration",
      );
      const management = await this.dependencies.managementConfig(managementSpaceId, principal.ownerUserId);
      const config = recordValue(management.managementAgent, "managementAgent");
      // The Run's own management generation is the authority. A registered
      // management Run is its Instance, never the configured Profile.
      if (management.version !== configGeneration || config.enabled !== true) {
        throw new RuntimeClientOperationError("management_activation_changed");
      }
    }
    // Every PostgreSQL handshake claims its own version before becoming live,
    // including a reconnect that races the predecessor's offline write.
    const channelAboutSession = metadata.routedAs === "management_channel_about";
    const channelDeliveryEnabled = !channelAboutSession;
    const runtimeSessionId = channelAboutSession
      ? requiredString(metadata.runtimeSessionId, "run.metadata.runtimeSessionId")
      : undefined;
    let instanceStatus = value.instanceStatus;
    if (refreshSession && !channelAboutSession &&
        (refreshSession.run.connectionVersion === undefined ||
         value.instanceId !== refreshSession.run.instanceId ||
         Number(value.instanceVersion) !== refreshSession.run.connectionVersion)) {
      throw new AgentInstanceReconnectRequiredError("Agent Instance connection claim is missing or superseded; reconnect required");
    }
    let connectionVersion = refreshSession?.run.connectionVersion ?? (
      connectMessage && !channelAboutSession
        ? requiredNonnegativeInteger(value.instanceVersion, "run.instanceVersion")
        : undefined
    );
    if (
      connectMessage && !channelAboutSession &&
      (this.dependencies.atomicInstanceConnect || instanceStatus === "offline") &&
      (value.status === "starting" || value.status === "running") &&
      typeof value.instanceId === "string" &&
      value.instanceId.trim()
    ) {
      const expectedVersion = requiredNonnegativeInteger(value.instanceVersion, "run.instanceVersion");
      const connectStarted = performance.now();
      try {
        const connected = await this.dependencies.runtime.transition(agentInstancePresenceCommand({
          atomicInstanceConnect: this.dependencies.atomicInstanceConnect === true,
          commandId: this.dependencies.atomicInstanceConnect
            ? runtimeCommandId("agent-connect", crypto.randomUUID())
            : runtimeVersionedCommandId("agent-presence", value.instanceId, expectedVersion),
          principal,
          instanceId: value.instanceId.trim(),
          expectedVersion,
          at: new Date().toISOString(),
        }));
        connectionVersion = requiredNonnegativeInteger(connected.entityVersion, "connect.entityVersion");
        if (connectionVersion < 1) throw new Error("Agent connection version is invalid");
        if (this.dependencies.atomicInstanceConnect) this.dependencies.observeAgentLaunchStage?.(
          "instance_connect", "ok", performance.now() - connectStarted);
      } catch (error) {
        if (this.dependencies.atomicInstanceConnect) this.dependencies.observeAgentLaunchStage?.(
          "instance_connect", "error", performance.now() - connectStarted);
        const retry = await queryAgentInstanceRun(this.dependencies.runtime, {
          runId: principal.runId,
          ownerUserId: principal.ownerUserId,
        });
        const recovered = recordValue(retry.run, "run");
        const recoveredStatus = recovered.instanceStatus;
        const recoveredVersion = recovered.instanceVersion;
        if (
          recovered.instanceId === value.instanceId &&
          (recovered.status === "starting" || recovered.status === "running") &&
          isLiveAgentStatus(recoveredStatus) &&
          Number.isSafeInteger(recoveredVersion) && Number(recoveredVersion) >= 1
        ) {
          instanceStatus = recoveredStatus;
          connectionVersion = Number(recoveredVersion);
          if (this.dependencies.atomicInstanceConnect) value.status = "running";
        } else {
          throw error;
        }
      }
      instanceStatus = "online";
      if (this.dependencies.atomicInstanceConnect) value.status = "running";
    }
    const channelInstanceId = value.channelInstanceId === undefined || value.channelInstanceId === null
      ? undefined
      : String(value.channelInstanceId).trim() || undefined;
    const cwd = typeof metadata.cwd === "string" && metadata.cwd.trim()
      ? metadata.cwd.trim()
      : typeof metadata.canonicalCwd === "string" && metadata.canonicalCwd.trim()
        ? metadata.canonicalCwd.trim()
        : undefined;
    const run: AgentInstanceAuthorityRunBinding = {
      kind: channelAboutSession ? "channel-about-session" : "channel-instance",
      runId: requiredString(value.runId ?? value.id, "run.runId"),
      // A Run acts as its Instance (a background session as its session).
      agentId: requiredString(value.instanceId ?? runtimeSessionId, "run.instanceId"),
      instanceId: channelAboutSession
        ? runtimeSessionId!
        : requiredString(value.instanceId, "run.instanceId"),
      executionKey: requiredString(metadata.executionKey, "run.metadata.executionKey"),
      channelId: requiredString(value.channelId, "run.channelId"),
      machineId: requiredString(metadata.machineId, "run.metadata.machineId"),
      hostId: typeof metadata.hostId === "string" ? metadata.hostId : "",
      status: liveRunStatus(value.status),
      instanceStatus: channelAboutSession ? "online" : liveInstanceStatus(instanceStatus),
      ...(connectionVersion !== undefined ? { connectionVersion } : {}),
      channelDeliveryEnabled,
      ...(channelInstanceId ? { channelInstanceId } : {}),
      ...(cwd ? { cwd } : {}),
    };
    if (run.runId !== principal.runId ||
        !liveRunIsAdmitted(run, principal, LIVE_RUN_ROUTED_FIELDS) ||
        run.kind !== principal.runKind ||
        (run.kind === "channel-about-session" && principal.channelWriteAllowed)) {
      throw new RuntimeClientOperationError("agent_run_binding_mismatch");
    }
    const presentation = connectMessage
      ? initialAgentInstancePresentation({
          message: connectMessage,
          runMetadata: metadata,
          workspace: value.workspace,
        })
      : undefined;
    return { user, principal, run, presentation };
  }

  private async persistTurnFailureNotice(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"agent_lifecycle">,
  ): Promise<void> {
    if (!shouldPersistAgentTurnFailureNotice(message)) return;
    if (!session.principal.channelWriteAllowed || session.run.kind === "channel-about-session") {
      return;
    }
    const command = agentTurnFailureAppendCommand({
      runId: session.principal.runId,
      instanceId: session.run.instanceId,
      executionKey: session.principal.executionKey,
      agentId: session.principal.agentId,
      agentName: session.principal.agentName,
      ownerUserId: session.principal.ownerUserId,
      channelId: message.channelId || session.principal.channelId,
      detail: message.detail,
      reason: message.reason,
      noticeId: message.requestId,
      senderSnapshot: agentMessagePresentation(session.presentation) ?? {},
    });
    if (!command) return;
    try {
      await this.dependencies.messages.append(command.payload, {
        actorUserId: session.principal.ownerUserId,
      });
    } catch (error) {
      console.error("Agent turn-failure notice could not be committed", error);
      return;
    }
    if (isAgentUsageLimitLifecycle(message) && session.run.kind === "channel-instance") {
      await this.handOffUsageLimitedInstance(session, message, command.messageId);
    }
  }

  /**
   * The Instance's provider account is used up. Its quota pool is held empty
   * until the reset, then xMatrix posts `@<name>:<n>:handoff:@auto` as the
   * owner: an ordinary handoff, interpreted like one anybody typed, picks the
   * successor on any machine. The committed turn-failure notice keys both, so
   * a replayed lifecycle signal repeats neither.
   */
  private async handOffUsageLimitedInstance(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"agent_lifecycle">,
    sourceMessageId: string,
  ): Promise<void> {
    const ids = await usageLimitHandoffIds(sourceMessageId);
    const channelId = session.run.channelId;
    const ownerUserId = session.principal.ownerUserId;
    try {
      await this.dependencies.runtime.holdUsageLimit({
        commandId: ids.commandId,
        actorUserId: ownerUserId,
        channelId,
        sourceInstanceId: session.run.instanceId,
        ...(typeof message.resetsAt === "string" ? { resetsAt: message.resetsAt.slice(0, 64) } : {}),
      });
    } catch (error) {
      console.error("Agent usage limit could not be recorded", error);
    }
    const body = usageLimitHandoffCommand(session.principal.agentName, session.run.channelInstanceId);
    if (!body) return;
    try {
      // xMatrix's, posted as the owner like other continuation notices: by
      // now the handoff may already be stopping the source Run, so that Run's
      // proof can no longer vouch for a message.
      await this.dependencies.messages.append({
        commandId: runtimeCommandId("agent-append", ids.noticeMessageId),
        messageId: ids.noticeMessageId,
        channelId,
        body,
        principal: { kind: "user", id: ownerUserId },
        senderSnapshot: productAgentSystemNoticeSenderSnapshot(ownerUserId),
        residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
          xmatrixUsageLimitHandoff: true, sourceMessageId } },
      }, { actorUserId: ownerUserId });
    } catch (error) {
      console.error("Agent usage-limit handoff could not be posted", error);
    }
  }

  private async appendMessage(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"channel_message">,
  ): Promise<AgentInstanceServerMessage> {
    if (!session.principal.channelWriteAllowed || session.run.kind === "channel-about-session") {
      throw new RuntimeClientOperationError("agent_read_only_session");
    }
    assertAgentAppendEnvelope(message);
    const appMetadata = {
      ...callerMessageMetadata(message.metadata),
      ...(message.appMentions?.length ? { appMentions: message.appMentions } : {}),
    };
    const residual = {
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(Object.keys(appMetadata).length > 0 ? { appMetadata } : {}),
    };
    return this.appendAsRun(session, message.requestId, {
      messageId: runtimeCommandId("message", message.requestId),
      commandPrefix: "agent-append",
      channelId: message.channelId,
      body: message.body,
      ...(Object.keys(residual).length > 0 ? { residual } : {}),
    });
  }

  /**
   * One fact the Run's runtime observed about its own work, kept in the
   * timeline as an activity entry (docs/design/conversation-activity.md §3.2).
   * The Hub validates the report and writes the body and metadata itself, so
   * a caller can never mint an activity entry through message metadata.
   */
  private async appendActivity(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"channel_activity">,
  ): Promise<AgentInstanceServerMessage> {
    if (!session.principal.channelWriteAllowed) {
      throw new RuntimeClientOperationError("agent_read_only_session");
    }
    const allowed = new Set(["activity", "channelId", "requestId", "type"]);
    if (Object.keys(message).some((field) => !allowed.has(field))) {
      throw new RuntimeClientOperationError("invalid_agent_message_fields");
    }
    let activity;
    try {
      activity = normalizeChannelActivity(message.activity);
    } catch (error) {
      if (error instanceof ChannelActivityInvalid) {
        throw new RuntimeClientOperationError("invalid_channel_activity");
      }
      throw error;
    }
    return this.appendAsRun(session, message.requestId, {
      messageId: runtimeCommandId("activity", message.requestId),
      commandPrefix: "agent-activity",
      channelId: message.channelId,
      body: channelActivityLine(activity),
      messageKind: CHANNEL_ACTIVITY_MESSAGE_KIND,
      residual: {
        appMetadata: { xmatrixProvenance: CHANNEL_ACTIVITY_PROVENANCE, xmatrixActivity: activity },
      },
    });
  }

  /** Append as this exact Run; the Authority derives identity from its proof. */
  private async appendAsRun(
    session: Readonly<AgentInstanceRuntimeSession>,
    requestId: string | undefined,
    input: {
      messageId: string;
      commandPrefix: string;
      channelId: string;
      body: string;
      messageKind?: string;
      residual?: Record<string, unknown>;
    },
  ): Promise<AgentInstanceServerMessage> {
    // Only reviewed runtime-presentation fields cross this boundary. The
    // receiving Authority derives stable Profile and Instance identity from
    // the principal and exact Run proof.
    const senderSnapshot = agentMessagePresentation(session.presentation) ?? {};
    const result = await this.dependencies.messages.append({
      commandId: runtimeCommandId(input.commandPrefix, input.messageId),
      messageId: input.messageId,
      channelId: input.channelId,
      body: input.body,
      ...(input.messageKind ? { messageKind: input.messageKind } : {}),
      principal: { kind: "agent", id: session.principal.agentId },
      agentRunProof: {
        runId: session.principal.runId,
        executionKey: session.principal.executionKey,
        instanceId: session.run.instanceId,
      },
      senderSnapshot,
      ...(input.residual ? { residual: input.residual } : {}),
    }, { actorUserId: session.principal.ownerUserId, senderRunId: session.principal.runId });
    requiredNonnegativeInteger(result.sequence, "append-message.sequence");
    return {
      type: "channel_message_dispatched",
      requestId,
      messageId: input.messageId,
      channelId: input.channelId,
      recipients: [],
    };
  }

  private async acknowledgeMessage(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"channel_message_ack">,
  ): Promise<undefined> {
    const sequence = requiredNonnegativeInteger(message.sequence, "channel_message_ack.sequence");
    await this.dependencies.messages.acknowledge({
      commandId: runtimeCommandId("agent-ack", `${session.run.instanceId}:${message.channelId}:${sequence}`),
      channelId: message.channelId,
      sequence,
      principal: { kind: "agent", id: session.principal.agentId },
    });
    return undefined;
  }

  private async emitJoinBirthMetric(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"join_channel">,
    result: AuthorityOutput,
  ): Promise<void> {
    // Room join_birth: empty afterSequence / zero history still stamps the
    // channel cursor and fans out channel_history_replayed to Human sockets.
    if (message.afterSequence !== undefined) return;
    await this.emitHistoryMetric(session, message.channelId, {
      mode: "join_birth",
      limit: message.historyLimit ?? 0,
      entryCount: 0,
      afterSequence: undefined,
      cursorSequence: 0,
      tailSequence: 0,
      truncated: false,
    });
    // Room reconnect catch-up on join also emits afterSequence metrics when
    // history frames were delivered after the stored cursor.
    const observability = historyObservability(result);
    if (observability && observability.entryCount > 0) {
      await this.emitHistoryMetric(session, message.channelId, afterSequenceMetricFields(observability));
    }
  }

  private async emitReplayMetric(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"replay_channel_history">,
    result: AuthorityOutput,
  ): Promise<void> {
    const observability = historyObservability(result);
    if (observability) {
      await this.emitHistoryMetric(session, message.channelId, afterSequenceMetricFields(observability));
      return;
    }
    const frames = Array.isArray(result) ? result : result ? [result] : [];
    const replayed = frames.filter((frame) =>
      frame && typeof frame === "object" && (frame as { type?: string }).type === "channel_history_replay"
    ) as Array<{ message?: { sequence?: number } }>;
    const sequences = replayed
      .map((frame) => frame.message?.sequence)
      .filter((value): value is number => Number.isSafeInteger(value));
    const replayedSequence = sequences.length ? Math.max(...sequences) : 0;
    await this.emitHistoryMetric(session, message.channelId, {
      mode: "afterSequence",
      limit: message.historyLimit ?? 0,
      entryCount: replayed.length,
      afterSequence: message.afterSequence ?? 0,
      cursorSequence: message.afterSequence ?? 0,
      replayedSequence,
      tailSequence: replayedSequence,
      truncated: false,
    });
  }

  private async emitHistoryMetric(
    session: Readonly<AgentInstanceRuntimeSession>,
    channelId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const cells = this.dependencies.runtimeCells?.(session.principal.ownerUserId) ?? [];
    if (cells.length === 0) return;
    const event = {
      id: crypto.randomUUID(),
      type: "channel_history_replayed" as const,
      workspaceUserId: session.principal.ownerUserId,
      agentId: session.principal.agentId,
      agentName: session.principal.agentName,
      channelId,
      metadata,
      timestamp: new Date().toISOString(),
    };
    try {
      await Promise.all(cells.map((cell) => cell.fetch(new Request(
        "https://relay-runtime/internal/product-human/observable-event",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId: session.principal.ownerUserId, event }),
        },
      ))));
    } catch {
      // Best-effort observability.
    }
  }

  private async unregister(
    session: Readonly<AgentInstanceRuntimeSession>,
    requestId?: string,
  ): Promise<AgentInstanceServerMessage> {
    if (session.run.kind === "channel-about-session") {
      return { type: "unregistered", requestId };
    }
    const response = await queryAgentInstanceRun(this.dependencies.runtime, {
      runId: session.run.runId,
      ownerUserId: session.principal.ownerUserId,
    });
    const run = recordValue(response.run, "run");
    const metadata = recordValue(run.metadata, "run.metadata");
    // An unregister belongs to this authenticated connection, not whichever
    // successor happens to own the Instance when the Run read completes.
    const expectedVersion = requiredNonnegativeInteger(session.run.connectionVersion, "connectionVersion");
    if (expectedVersion < 1) throw new Error("Agent connection version is invalid");
    await this.dependencies.runtime.transition({
      commandId: runtimeVersionedCommandId("agent-unregister", session.run.instanceId, expectedVersion),
      actorUserId: session.principal.ownerUserId,
      at: new Date().toISOString(),
      kind: "instance_transition",
      spaceId: session.principal.spaceId,
      channelId: session.run.channelId,
      instanceId: session.run.instanceId,
      expectedVersion,
      status: "offline",
      // For daemon-managed executions, the authenticated host exit report
      // owns completed/failed Run terminality. Stopping the Run here races
      // that report and can mask an exit-0 result as `stopped`. Unmanaged
      // Agent unregisters retain their existing terminal semantics.
      terminal: agentInstanceUnregisterIsTerminal(metadata),
    });
    return { type: "unregistered", requestId };
  }
}

function runPrincipal(value: AgentRunPrincipal): AgentInstanceRunPrincipal {
  return {
    ownerUserId: value.ownerUserId,
    agentId: value.agentId,
    agentName: value.agentName,
    spaceId: value.spaceId,
    runId: value.runId,
    executionKey: value.executionKey,
    channelId: value.channelId,
    machineId: value.machineId,
    hostId: value.hostId,
    runKind: value.runKind === "channel-about-session"
      ? "channel-about-session"
      : "channel-instance",
    channelWriteAllowed: value.channelWriteAllowed !== false,
  };
}

function connectedAgent(
  user: AuthUser,
  principal: AgentInstanceRunPrincipal,
  run: AgentInstanceAuthorityRunBinding,
  message: AgentInstanceConnectMessage,
  presentation?: AgentInstancePresentation,
): SerializedAgent {
  const now = new Date().toISOString();
  const channelInstanceId = run.channelInstanceId || "1";
  return {
    id: principal.agentId,
    instanceId: run.instanceId,
    channelInstanceId,
    userId: principal.ownerUserId,
    name: principal.agentName,
    type: requiredString(message.runtime.kind, "runtime.kind"),
    lifetime: "short",
    email: user.email,
    metadata: { ...message.runContext, runId: principal.runId, executionKey: principal.executionKey },
    connectedAt: now,
    lastSeenAt: now,
    status: run.instanceStatus,
    ...agentSummaryPresentation(presentation),
    instances: [{
      id: run.instanceId,
      channelInstanceId,
      channelId: principal.channelId,
      label: `${principal.agentName || "agent"}:${channelInstanceId}`,
      connectedAt: now,
      lastSeenAt: now,
      status: run.instanceStatus,
      ...(run.machineId ? { machineId: run.machineId } : {}),
      ...(run.hostId ? { hostId: run.hostId } : {}),
      ...(run.cwd ? { cwd: run.cwd } : {}),
      ...presentation,
    }],
  };
}

function assertBoundChannel(session: Readonly<AgentInstanceRuntimeSession>, message: PortMessage): void {
  if ("channelId" in message && typeof message.channelId === "string" &&
      message.channelId !== session.principal.channelId) {
    throw new RuntimeClientOperationError("agent_channel_scope_mismatch");
  }
}

function assertAgentAppendEnvelope(message: Message<"channel_message">): void {
  const allowed = new Set([
    "appMentions",
    "body",
    "channelId",
    "metadata",
    "replyToMessageId",
    "requestId",
    "type",
  ]);
  const unexpected = Object.keys(message).filter((field) => !allowed.has(field));
  if (unexpected.length > 0) {
    throw new RuntimeClientOperationError("invalid_agent_message_fields");
  }
}

type HistoryObservability = {
  mode: string;
  limit: number;
  entryCount: number;
  afterSequence: number;
  cursorSequence: number;
  effectiveAfterSequence: number;
  replayedSequence: number;
  tailSequence: number;
  truncated: boolean;
};

function historyObservability(result: AuthorityOutput): HistoryObservability | undefined {
  if (!result || typeof result !== "object") return undefined;
  const observability = (result as { observability?: Record<string, unknown> }).observability;
  if (!observability || typeof observability !== "object") return undefined;
  const entryCount = Number(observability.entryCount);
  const afterSequence = Number(observability.afterSequence);
  const cursorSequence = Number(observability.cursorSequence);
  const effectiveAfterSequence = Number(observability.effectiveAfterSequence);
  const replayedSequence = Number(observability.replayedSequence);
  const tailSequence = Number(observability.tailSequence);
  const limit = Number(observability.limit);
  if (![entryCount, afterSequence, cursorSequence, effectiveAfterSequence, replayedSequence, tailSequence, limit]
    .every((value) => Number.isSafeInteger(value))) {
    return undefined;
  }
  return {
    mode: typeof observability.mode === "string" ? observability.mode : "afterSequence",
    limit,
    entryCount,
    afterSequence,
    cursorSequence,
    effectiveAfterSequence,
    replayedSequence,
    tailSequence,
    truncated: observability.truncated === true,
  };
}

function afterSequenceMetricFields(observability: HistoryObservability): Record<string, unknown> {
  return {
    mode: "afterSequence",
    limit: observability.limit,
    entryCount: observability.entryCount,
    afterSequence: observability.afterSequence,
    cursorSequence: observability.cursorSequence,
    effectiveAfterSequence: observability.effectiveAfterSequence,
    replayedSequence: observability.replayedSequence,
    tailSequence: observability.tailSequence,
    truncated: observability.truncated,
  };
}

function requireMethods(value: object, methods: readonly string[], label: string): void {
  for (const method of methods) {
    if (typeof (value as Record<string, unknown>)[method] !== "function") {
      throw new Error(`${label} is incomplete: ${method} is required`);
    }
  }
}

function liveRunStatus(value: unknown): "starting" | "running" {
  if (value !== "starting" && value !== "running") throw new RuntimeClientOperationError("agent_run_not_live");
  return value;
}

function liveInstanceStatus(value: unknown): LiveAgentStatus {
  if (!isLiveAgentStatus(value)) {
    throw new RuntimeClientOperationError("agent_instance_not_live");
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function requiredNonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} is invalid`);
  return Number(value);
}
