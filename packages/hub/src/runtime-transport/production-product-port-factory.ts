import { withRegistrationQuota, channelInstanceQuota } from "../registration-quota-presentation";
import type {
  AgentInstanceOfflineReason,
  AgentStatus,
  ChannelMessage,
  LlmUsage,
  SerializedAgent,
  SerializedChannel,
} from "@xmatrix/protocol";
import type { AgentInstanceServerMessage } from "@xmatrix/protocol/connections/agent-instance";
import type { HumanServerMessage } from "@xmatrix/protocol/connections/human";
import type { Env } from "../types";
import {
  PostgresAgentInstancePort,
  type AgentInstanceRuntimeSignalsPort,
} from "./postgres-agent-instance-port";
import {
  AgentInstanceControlResultWaiterRegistry,
  AgentInstanceRuntimeSignalRouter,
  type AgentInstanceRuntimeSignal,
  type AgentInstanceRuntimeFanout,
  type RuntimeAnalyticsSink,
} from "./agent-instance-runtime-signals";
import type { AgentInstanceRuntimeSession } from "./agent-instance-port";
import {
  mergeAgentInstancePresentation,
} from "./agent-instance-presentation";
import {
  overlayAgentPresenceOnChannel,
  serializeAgentFromSession,
} from "./agent-instance-live-presentation";
import { channelHasComputedAgentInstance } from "./agent-presence-snapshot";
import { AgentChannelHistory, type ReadAgentChannelHistory } from "./agent-channel-history";
import { PostgresHumanPort } from "./postgres-human-port";
import type { AgentInstanceRuntime } from "./agent-instance-run-query";
import { createHumanPresenceFanout, humanFanoutChannelReader, type HumanFanoutChannelReader } from "./human-presence-fanout";
import {
  channelForSharedPresenceFanout,
  humanMemberIdsForChannel,
  overlayHumanPresenceOnChannel,
  visibleHumanUserIds,
} from "./human-live-presence";
import { PostgresMachineDaemonPort } from "./postgres-machine-daemon-port";
import type { RelayRuntimeProductPortFactory } from "./relay-runtime-product-adapter";
import { channelHistoryAs } from "./runtime-messages";
import {
  channelAgentPresenceDeliveryBody,
  type ChannelAgentPresenceRecipient,
} from "./channel-agent-presence-delivery";
import { publishRuntimeChannelAgentPresence } from "./runtime-route-directory-delivery";
import { RELAY_RUNTIME_SELECTED_CELL } from "./runtime-cell-locator";

const RUNTIME_SIGNAL_TYPES = new Set<string>([
  "client_network_sample",
  "presence_update",
  "agent_model_switch_result",
  "agent_effort_switch_result",
  "agent_lifecycle",
  "event_publish",
]);

/**
 * Production composition for RelayRuntime product sockets, built only from
 * Worker/DO bindings. Every port answers from PostgreSQL.
 */
export function createProductionRelayRuntimeProductPortFactory(
  env: Env,
  options: {
    /** How presence fanout reads a Channel as a Human; PostgreSQL by default. */
    readChannel?: HumanFanoutChannelReader;
    /** The Agent Instance socket's Run and Instance facts; PostgreSQL by default. */
    runtime?: AgentInstanceRuntime;
    /** How Agent sockets read Channel history; PostgreSQL by default. */
    readHistory?: ReadAgentChannelHistory;
    analytics?: RuntimeAnalyticsSink;
    /** Durable Object waitUntil boundary for post-commit delivery/orchestration. */
    scheduleBackground?: (task: Promise<unknown>) => void;
    /** This Runtime cell; live fanout must not RPC back into the same object. */
    runtimeSelf?: { cellName: () => string; fetch(request: Request): Promise<Response> };
  } = {},
): RelayRuntimeProductPortFactory {
  const analytics = options.analytics ?? analyticsSinkFromEnv(env);
  const readChannel = options.readChannel ?? humanFanoutChannelReader(env);
  const readHistory = options.readHistory ?? postgresAgentChannelHistory(env);
  const controlWaiters = new AgentInstanceControlResultWaiterRegistry();
  const liveAgentFanout = new LiveAgentInstanceFanout();
  const signalRouter = new AgentInstanceRuntimeSignalRouter(
    analytics,
    liveAgentFanout,
    controlWaiters,
  );
  const signals = createSignalPort(signalRouter, liveAgentFanout, controlWaiters);
  // Delivery deduplication only. Readings always come from the directory authority.
  const publishedQuotaReadings = new Map<string, string>();

  return {
    human: () => PostgresHumanPort.fromEnv({ env }),
    machineDaemon: (terminateInstance, deliverPending, quotaChanged) => PostgresMachineDaemonPort.fromEnv({
      env, terminateInstance,
      ...(quotaChanged ? { quotaChanged } : {}),
      ...(deliverPending ? { deliverPending } : {}),
      ...(options.scheduleBackground ? { keepAlive: options.scheduleBackground } : {}),
    }),
    agentInstance: () => PostgresAgentInstancePort.fromEnv({
      env,
      history: new AgentChannelHistory({ read: readHistory, serializeAgent: serializeAgentFromSession }),
      signals,
      ...(options.scheduleBackground
        ? { scheduleBackground: options.scheduleBackground }
        : {}),
      ...(options.runtimeSelf ? { runtimeSelf: options.runtimeSelf } : {}),
      ...(options.runtime ? { runtime: options.runtime } : {}),
    }),
    onHumanPresenceChange: createHumanPresenceFanout({ readChannel }),
    onRegistrationQuotaChange: async input => fanoutRegistrationQuota({ ...input,
      live: liveAgentFanout.sessions(), readChannel }),
    onAgentPresenceChange: async ({
      reason, session, status: reportedStatus, liveHumanSessions, deliver, deliverAgentPresence, machineReachable,
    }) => {
      // An open Instance socket on an unreachable machine is shown offline,
      // whatever it last reported; nothing sent to it would be acted on.
      const shown = (
        live: Readonly<AgentInstanceRuntimeSession>,
        status: AgentStatus | undefined,
      ): { status?: AgentStatus; offlineReason?: AgentInstanceOfflineReason } =>
        machineReachable && !machineReachable(live)
          ? { status: "offline", offlineReason: "machine_offline" }
          : { status };
      const { status, offlineReason } = reason === "disconnect"
        ? { status: reportedStatus, offlineReason: undefined }
        : shown(session, reportedStatus);
      const live = liveAgentFanout.sessions().filter(candidate => candidate.run.instanceId !== session.run.instanceId);
      const payload = await readChannel(session.run.channelId, session.principal.ownerUserId, "agent-presence");
      const accountQuota = payload ? channelInstanceQuota(payload.channel, session.run.instanceId) : undefined;
      const overlayLiveChannel = (channel: SerializedChannel, channelId: string) => {
        for (const liveSession of live) {
          if (liveSession.run.channelId !== channelId || !channelHasComputedAgentInstance(channel, liveSession.run.instanceId)) continue;
          channel = overlayAgentPresenceOnChannel(channel, { reason: "update", session: liveSession,
            ...shown(liveSession, liveSession.run.instanceStatus) });
        }
        return channel;
      };
      const registration = payload && Object.values(payload.channel.memberPresence ?? {}).flatMap(presence =>
        presence.kind === "agent" && presence.instances?.some(instance => instance.id === session.run.instanceId)
          ? [presence.registration] : [])[0];
      const quotaKey = registration ? JSON.stringify([registration.ownerUserId, registration.machineId, registration.harness]) : undefined;
      const digest = JSON.stringify(withRegistrationQuota(undefined, accountQuota));
      if (quotaKey && publishedQuotaReadings.get(quotaKey) !== digest) {
        if (publishedQuotaReadings.size >= 512) publishedQuotaReadings.delete(publishedQuotaReadings.keys().next().value!);
        publishedQuotaReadings.set(quotaKey, digest);
        await fanoutRegistrationQuota({ ownerUserId: session.principal.ownerUserId, machineId: session.run.machineId,
          skipChannelId: session.run.channelId, live, readChannel, liveHumanSessions, deliver });
      }
      const ownerUserId = session.principal.ownerUserId;
      const remoteRecipients: ChannelAgentPresenceRecipient[] = [];
      const remember = (recipient: ChannelAgentPresenceRecipient) => {
        remoteRecipients.push(recipient);
      };
      const lifecycle = reason === "disconnect" ? agentLifecycleOfflineFrame(session) : undefined;
      const observable: HumanServerMessage | undefined = reason === "disconnect" ? {
        type: "observable_event",
        event: {
          id: crypto.randomUUID(),
          type: "agent_disconnected",
          workspaceUserId: ownerUserId,
          agentId: session.principal.agentId,
          agentName: session.principal.agentName,
          channelId: session.run.channelId,
          metadata: {
            reason: "websocket_closed",
            instanceId: session.run.instanceId,
          },
          timestamp: new Date().toISOString(),
        },
      } : undefined;
      if (reason === "disconnect" && lifecycle && observable) {
        // Always notify the owner even when Authority channel read fails (socket already gone).
        deliver(ownerUserId, lifecycle);
        deliver(ownerUserId, observable);
        remember({ userId: ownerUserId, digest: false, card: false, channel: false,
          immediate: ["lifecycle", "observable"] });
      }
      // Room parity: Human UIs patch Agents quota chips (Grok 1mo, Codex 5h/1w, …)
      // from enhanced_presence. LiveAgentInstanceFanout only delivers that frame
      // to peer Agent Instances — never to Human sockets — so Authority-active product
      // must rebroadcast it here. Prefer owner delivery even when get-channel fails
      // so usage meters are not gated on durable channel reads.
      const enhancedPresence = reason === "disconnect"
        ? undefined
        : humanEnhancedPresenceFrame(session, status, offlineReason, accountQuota);
      // A status or activity report is the frequent case, from every working
      // Agent: sockets showing this conversation get it at once, every other
      // socket that takes digests gets the card once a second. Joins and
      // leaves stay immediate everywhere.
      if (enhancedPresence) {
        if (reason === "update") {
          deliverAgentPresence(ownerUserId, session.run.channelId, enhancedPresence, undefined);
          remember({ userId: ownerUserId, digest: true, card: true, channel: false, immediate: [] });
        } else {
          deliver(ownerUserId, enhancedPresence);
          remember({ userId: ownerUserId, digest: false, card: true, channel: false, immediate: [] });
        }
      }
      const fanOut = (channel: SerializedChannel | undefined) => {
        scheduleAgentPresenceAcrossCells({
          env, scheduleBackground: options.scheduleBackground, runtimeSelf: options.runtimeSelf,
          channelId: session.run.channelId, reason, card: enhancedPresence?.agent, channel,
          lifecycle, observable, recipients: remoteRecipients,
        });
      };
      if (!payload) {
        fanOut(undefined);
        return;
      }
      payload.channel = overlayAgentPresenceOnChannel(payload.channel, {
        reason,
        session,
        status,
        ...(offlineReason ? { offlineReason } : {}),
      });
      payload.channel = overlayLiveChannel(payload.channel, session.run.channelId);
      const humanMemberIds = humanMemberIdsForChannel(
        payload.channel,
        payload.openChannelHumanMemberIdsBySpace,
      );
      const channel = channelForSharedPresenceFanout(
        overlayHumanPresenceOnChannel(
          payload.channel,
          liveHumanSessions,
          humanMemberIds,
        ),
      );
      for (const userId of visibleHumanUserIds(humanMemberIds)) {
        // Owner already received enhanced_presence above; still send to other
        // channel human members so Agents chips stay live for everyone present.
        const card = enhancedPresence && userId !== ownerUserId ? enhancedPresence : undefined;
        if (reason === "update") {
          deliverAgentPresence(userId, session.run.channelId, card, { type: "channel_updated", channel });
          remember({ userId, digest: true, card: Boolean(card), channel: true, immediate: [] });
        } else {
          if (card) deliver(userId, card);
          deliver(userId, { type: "channel_updated", channel });
          const immediate: Array<"lifecycle" | "observable"> = [];
          if (reason === "disconnect" && userId !== ownerUserId && lifecycle) {
            // Owner already notified above; fan out to other channel members.
            deliver(userId, lifecycle);
            immediate.push("lifecycle");
          }
          remember({ userId, digest: false, card: Boolean(card), channel: true, immediate });
        }
      }
      fanOut(channel);
    },
  };
}

/**
 * Humans watching this Channel may sit in another user's Runtime cell. The
 * local sockets were already told; this reaches the other cells, and never
 * this one. A missing runtime binding (tests, shadow with no directory) does
 * nothing. Failure here must not fail the Agent's own presence report.
 */
function scheduleAgentPresenceAcrossCells(input: {
  env: Env;
  scheduleBackground?: (task: Promise<unknown>) => void;
  runtimeSelf?: { cellName: () => string };
  channelId: string;
  reason: "connect" | "update" | "disconnect";
  card?: SerializedAgent;
  channel?: SerializedChannel;
  lifecycle?: HumanServerMessage;
  observable?: HumanServerMessage;
  recipients: ChannelAgentPresenceRecipient[];
}): void {
  if (!input.env.RELAY_RUNTIME || input.recipients.length === 0) return;
  const body = channelAgentPresenceDeliveryBody({
    channelId: input.channelId,
    reason: input.reason,
    ...(input.card ? { card: input.card } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    ...(input.observable ? { observable: input.observable } : {}),
    recipients: input.recipients,
  });
  if (!body) return;
  const task = publishRuntimeChannelAgentPresence({
    env: input.env,
    channelId: input.channelId,
    body,
    exceptCell: input.runtimeSelf?.cellName() ?? RELAY_RUNTIME_SELECTED_CELL,
  }).catch((error: unknown) => {
    console.error("Agent presence cross-cell delivery failed", error);
  });
  if (input.scheduleBackground) input.scheduleBackground(task);
  else void task;
}

function createSignalPort(
  router: AgentInstanceRuntimeSignalRouter,
  fanout: LiveAgentInstanceFanout,
  controlWaiters: AgentInstanceControlResultWaiterRegistry,
): AgentInstanceRuntimeSignalsPort {
  return {
    async publish(session, message) {
      if (!RUNTIME_SIGNAL_TYPES.has(message.type)) {
        throw new Error(`Unsupported Agent Instance runtime signal: ${message.type}`);
      }
      await router.route(session, message as AgentInstanceRuntimeSignal);
      return undefined;
    },
    async awaitControlResult(binding, timeoutMs) {
      const result = await controlWaiters.register(binding, timeoutMs);
      return {
        ...(result.value ? { value: result.value } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    },
    connected(session, deliver) {
      fanout.connected(session, deliver);
    },
    disconnected(session) {
      if (fanout.disconnected(session)) router.disconnected(session.run.instanceId);
    },
  };
}

interface LiveAgentTarget {
  session: Readonly<AgentInstanceRuntimeSession>;
  deliver(message: AgentInstanceServerMessage): Promise<void>;
}

/** Same-DO, same-owner/channel live fanout. It owns no durable or Authority state. */
class LiveAgentInstanceFanout implements AgentInstanceRuntimeFanout {
  private readonly targets = new Map<string, LiveAgentTarget>();

  connected(
    session: Readonly<AgentInstanceRuntimeSession>,
    deliver: (message: AgentInstanceServerMessage) => Promise<void>,
  ): void {
    this.targets.set(session.run.instanceId, { session, deliver });
  }

  disconnected(session: Readonly<AgentInstanceRuntimeSession>): boolean {
    const current = this.targets.get(session.run.instanceId);
    if (current?.session !== session) return false;
    return this.targets.delete(session.run.instanceId);
  }

  sessions(): readonly Readonly<AgentInstanceRuntimeSession>[] {
    return [...this.targets.values()].map(({ session }) => session);
  }

  async publish(session: Readonly<AgentInstanceRuntimeSession>, message: AgentInstanceRuntimeSignal): Promise<void> {
    const sender = this.targets.get(session.run.instanceId);
    if (sender?.session !== session) throw new Error("Agent Instance signal sender has no live Runtime binding");
    const outbound = liveAgentSignalMessage(session, message);
    if (!outbound) return;
    const recipients = [...this.targets.values()].filter(({ session: candidate }) =>
      candidate !== session &&
      candidate.principal.ownerUserId === session.principal.ownerUserId &&
      candidate.principal.channelId === session.principal.channelId
    );
    const results = await Promise.allSettled(recipients.map(({ deliver }) => deliver(outbound)));
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("Agent Instance live signal fanout failed");
    }
  }
}

/**
 * Room-parity Human frame: full live Agent card including usage/quota meters.
 * Built from session.presentation (already merged by AgentInstanceRuntimeTransport
 * before onAgentPresenceChange runs).
 */
function humanEnhancedPresenceFrame(
  session: Readonly<AgentInstanceRuntimeSession>,
  status: AgentStatus | undefined,
  offlineReason: AgentInstanceOfflineReason | undefined,
  accountQuota: LlmUsage | undefined,
): Extract<HumanServerMessage, { type: "enhanced_presence" }> {
  const agentStatus = status ?? session.run.instanceStatus;
  // Carry the Agent's account windows, not just this Instance's last read, so
  // the Human UI patches every Channel showing the Agent with the same meters.
  const usage = withRegistrationQuota(session.presentation?.usage, accountQuota);
  const { usage: _instanceUsage, ...presentation } = session.presentation ?? {};
  return {
    type: "enhanced_presence",
    agent: {
      ...serializeAgentFromSession(session, { ...presentation, ...(usage ? { usage } : {}) },
        agentStatus, offlineReason),
      status: agentStatus,
    },
  };
}

function liveAgentSignalMessage(
  session: Readonly<AgentInstanceRuntimeSession>,
  message: AgentInstanceRuntimeSignal,
): AgentInstanceServerMessage | undefined {
  if (message.type === "presence_update") {
    const presentation = mergeAgentInstancePresentation(session.presentation, message);
    return {
      type: "enhanced_presence",
      agent: {
        ...serializeAgentFromSession(
          session,
          presentation,
          message.status ?? session.run.instanceStatus,
        ),
        status: message.status ?? session.run.instanceStatus,
      },
    };
  }

  if (message.type === "agent_lifecycle") {
    return {
      type: "agent_lifecycle",
      channelId: message.channelId ?? session.principal.channelId,
      agentId: session.principal.agentId,
      instanceId: session.run.instanceId,
      agentName: session.principal.agentName,
      layer: message.layer,
      status: message.status,
      reason: message.reason,
      detail: message.detail,
      snapshot: message.snapshot,
      ts: message.ts ?? new Date().toISOString(),
    };
  }
  if (message.type === "event_publish") {
    const requestedTimestamp = typeof message.timestamp === "string" && message.timestamp.length <= 64 &&
      Number.isFinite(Date.parse(message.timestamp)) ? message.timestamp : undefined;
    // Room channelVisibleEventPayload: force this session's instance identity
    // onto the published payload so Human subscribers see channelInstanceId.
    const enrichedPayload = enrichAgentEventPayload(session, message.channelId, message.payload);
    return {
      type: "observable_event",
      event: {
        id: typeof message.eventId === "string" && message.eventId.trim() && message.eventId.length <= 160
          ? message.eventId.trim()
          : crypto.randomUUID(),
        type: "event_published",
        workspaceUserId: session.principal.ownerUserId,
        agentId: session.principal.agentId,
        agentName: session.principal.agentName,
        channelId: message.channelId,
        metadata: { eventType: message.eventType, payload: enrichedPayload },
        timestamp: requestedTimestamp ?? new Date().toISOString(),
      },
    };
  }
  return undefined;
}

function analyticsSinkFromEnv(env: Env): RuntimeAnalyticsSink {
  const dataset = env.DIAGNOSTICS_AE;
  if (dataset && typeof dataset.writeDataPoint === "function") {
    return {
      writeDataPoint(event) {
        try {
          dataset.writeDataPoint(event);
        } catch {
          // Analytics is best-effort; Runtime never persists observability to Authority.
        }
      },
    };
  }
  return { writeDataPoint() {} };
}

/** Agent sockets read Channel history from PostgreSQL as the Agent. */
export function postgresAgentChannelHistory(env: Env): ReadAgentChannelHistory {
  return async ({ agentId, ...read }) => {
    const payload = await channelHistoryAs(env, { ...read, principal: { kind: "agent", id: agentId } }) as {
      messages?: ChannelMessage[];
      historyHeadSequence?: number;
      principalAckedSequence?: number;
    };
    const messages = (Array.isArray(payload.messages) ? payload.messages : []).map(withPresentableSender);
    const headFromMessages = Math.max(0, ...messages.map((entry) => Number(entry.sequence) || 0));
    return {
      messages,
      headSequence: Math.max(0, typeof payload.historyHeadSequence === "number"
        ? payload.historyHeadSequence
        : headFromMessages),
      ackedSequence: Math.max(0, Number(payload.principalAckedSequence) || 0),
    };
  };
}

/** Agents read every sender with a kind, user id, label and email; older rows can lack some. */
function withPresentableSender(entry: ChannelMessage): ChannelMessage {
  const from = entry.from && typeof entry.from === "object" && !Array.isArray(entry.from)
    ? entry.from as unknown as Record<string, unknown>
    : {};
  const kind = typeof from.kind === "string" ? from.kind : "user";
  const userId = typeof from.userId === "string" && from.userId.trim()
    ? from.userId
    : (typeof from.identityId === "string" ? from.identityId.replace(/^user:/, "") : "unknown");
  const label = typeof from.label === "string" && from.label.trim()
    ? from.label
    : (typeof from.name === "string" && from.name.trim() ? from.name : userId);
  const email = typeof from.email === "string" && from.email.trim()
    ? from.email
    : `${userId}@xmatrix.local`;
  return { ...entry, from: { ...from, kind, userId, label, email } } as ChannelMessage;
}

function enrichAgentEventPayload(
  session: Readonly<AgentInstanceRuntimeSession>,
  channelId: string,
  payload: unknown,
): Record<string, unknown> {
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>) }
    : {};
  const agentRaw = record.agent;
  const agentRecord = agentRaw && typeof agentRaw === "object" && !Array.isArray(agentRaw)
    ? { ...(agentRaw as Record<string, unknown>) }
    : {};
  const channelInstanceId = session.run.channelInstanceId || "1";
  return {
    ...record,
    channelId,
    agent: {
      ...agentRecord,
      id: session.principal.agentId,
      name: session.principal.agentName,
      instanceId: session.run.instanceId,
      channelInstanceId,
      runtimeInstanceId: session.run.instanceId,
    },
  };
}

function agentLifecycleOfflineFrame(session: Readonly<AgentInstanceRuntimeSession>) {
  return {
    type: "agent_lifecycle" as const,
    ts: new Date().toISOString(),
    layer: "transport" as const,
    status: "offline" as const,
    reason: "websocket_closed" as const,
    agentId: session.principal.agentId,
    agentName: session.principal.agentName,
    channelId: session.run.channelId,
    instanceId: session.run.instanceId,
    channelInstanceId: session.run.channelInstanceId || "1",
  };
}

/** Refresh the owner's live/focused Channels, including shared pools across machines.
 * The Channel read authorizes recipients and resolves each Instance's own harness. */
async function fanoutRegistrationQuota(input: {
  ownerUserId: string; machineId: string; skipChannelId?: string;
  live: readonly Readonly<AgentInstanceRuntimeSession>[]; readChannel: HumanFanoutChannelReader;
  liveHumanSessions: readonly import("./human-live-presence").LiveHumanSessionSnapshot[];
  deliver: (userId: string, message: HumanServerMessage) => boolean;
}): Promise<void> {
  const channels = [...new Set([...input.live.filter(session => session.principal.ownerUserId === input.ownerUserId &&
    session.run.channelId !== input.skipChannelId).map(session => session.run.channelId), ...input.liveHumanSessions.flatMap(session =>
      session.focusedChannelId && session.focusedChannelId !== input.skipChannelId ? [session.focusedChannelId] : [])])];
  for (let offset = 0; offset < channels.length; offset += 4) {
    await Promise.all(channels.slice(offset, offset + 4).map(async channelId => {
      const payload = await input.readChannel(channelId, input.ownerUserId, "registration-quota");
      if (!payload || !Object.values(payload.channel.memberPresence ?? {}).some(presence => presence.kind === "agent" &&
          presence.registration?.ownerUserId === input.ownerUserId)) return;
      const members = humanMemberIdsForChannel(payload.channel, payload.openChannelHumanMemberIdsBySpace);
      let channel = payload.channel;
      for (const session of input.live) {
        if (session.run.channelId !== channelId || !channelHasComputedAgentInstance(channel, session.run.instanceId)) continue;
        const existing = Object.values(channel.memberPresence ?? {}).flatMap(presence => presence.instances ?? [])
          .find(instance => instance.id === session.run.instanceId);
        channel = overlayAgentPresenceOnChannel(channel, { reason: "update", session,
          ...(existing?.offlineReason === "machine_offline" ? { status: "offline", offlineReason: "machine_offline" } : {}) });
      }
      const frame: HumanServerMessage = { type: "channel_updated", channel: channelForSharedPresenceFanout(
        overlayHumanPresenceOnChannel(channel, input.liveHumanSessions, members)) };
      for (const userId of visibleHumanUserIds(members)) input.deliver(userId, frame);
    }));
  }
}
