import { readOwnerRegistrationQuotaState, readRegistrationQuotaState, registrationQuotaKey,
  type RegistrationQuotaReading } from "@xmatrix/db";
import { withRegistrationQuota } from "@xmatrix/protocol";
import type {
  AgentInstanceOfflineReason,
  AgentRegistrationKey,
  AgentStatus,
  ChannelMessage,
  LlmUsage,
  SerializedAgent,
  SerializedChannel,
} from "@xmatrix/protocol";
import { channelInstanceQuota } from "../registration-quota-presentation";
import { runtimeDirectory } from "../runtime";
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
import {
  PRESENCE_AUDIENCE_TTL_MS, PresenceAudiences, type PresenceAudience, type PresenceStorage,
} from "./presence-audiences";
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
    /** Every registration of one owner with its quota reading; PostgreSQL by default. */
    readOwnerQuota?: (ownerUserId: string) => Promise<readonly RegistrationQuotaReading[]>;
    /** One registration's quota reading; PostgreSQL by default. */
    readQuota?: (registration: AgentRegistrationKey) => Promise<LlmUsage | undefined>;
    /** The Agent Instance socket's Run and Instance facts; PostgreSQL by default. */
    runtime?: AgentInstanceRuntime;
    /** How Agent sockets read Channel history; PostgreSQL by default. */
    readHistory?: ReadAgentChannelHistory;
    analytics?: RuntimeAnalyticsSink;
    /** Durable Object waitUntil boundary for post-commit delivery/orchestration. */
    scheduleBackground?: (task: Promise<unknown>) => void;
    /** This Runtime cell; live fanout must not RPC back into the same object. */
    runtimeSelf?: { cellName: () => string; fetch(request: Request): Promise<Response> };
    /** This Runtime cell's own storage, which outlives its hibernation. */
    storage?: PresenceStorage;
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
  const readOwnerQuota = options.readOwnerQuota ??
    ((ownerUserId: string) => readOwnerRegistrationQuotaState(runtimeDirectory(env), ownerUserId, crypto.randomUUID()));
  // Delivery deduplication only. Readings always come from the directory authority.
  const publishedQuotaReadings = new Map<string, string>();
  /* A registration's reading reaches this cell's user once per change, and
     the client applies it to every Agent it shows under the registration.
     Other people's sockets live in their own cells: they see the reading on
     the presence cards of the Agents they watch. */
  const publishQuota = (userId: string, registration: AgentRegistrationKey, quota: LlmUsage | undefined,
    deliver: (userId: string, message: HumanServerMessage) => boolean) => {
    const key = `${userId}\n${registrationQuotaKey(registration)}`;
    const usage = withRegistrationQuota(undefined, quota);
    const digest = JSON.stringify(usage);
    if (publishedQuotaReadings.get(key) === digest) return;
    if (publishedQuotaReadings.size >= 512) publishedQuotaReadings.delete(publishedQuotaReadings.keys().next().value!);
    publishedQuotaReadings.set(key, digest);
    deliver(userId, { type: "registration_quota", registration, usage });
  };
  const readQuota = options.readQuota ?? (async (registration: AgentRegistrationKey) =>
    (await readRegistrationQuotaState(runtimeDirectory(env), [registration], crypto.randomUUID()))
      .get(registrationQuotaKey(registration)));
  /* A status report from a working Agent is the frequent case. It reuses what
     the Instance's last Channel read said about who may see it and its quota,
     and reads nothing: joining and leaving read the Channel again, a catalog
     change in its Space forgets the audience, and the quota is read again
     when the Instance reports a newer provider reading or a minute passes. */
  const audiences = new PresenceAudiences(options.storage);
  /** The registration's reading for a status report, and whether this report read it. */
  const audienceQuota = async (instanceId: string, audience: PresenceAudience,
    session: Readonly<AgentInstanceRuntimeSession>): Promise<{ quota: LlmUsage | undefined; read: boolean }> => {
    if (!audience.registration) return { quota: undefined, read: false };
    const held = await audiences.quota(audience.registration);
    const reported = reportedQuotaAt(session);
    if (held && reported <= audience.quotaCheckedThrough && Date.now() - held.readAt < PRESENCE_QUOTA_TTL_MS) {
      return { quota: held.quota, read: false };
    }
    let quota: LlmUsage | undefined;
    try {
      quota = await readQuota(audience.registration);
    } catch {
      // The reading held stays shown; the next report tries again.
      return { quota: held?.quota, read: false };
    }
    await audiences.rememberQuota(audience.registration, quota);
    if (reported > audience.quotaCheckedThrough) {
      await audiences.remember(instanceId, { ...audience, quotaCheckedThrough: reported });
    }
    return { quota, read: true };
  };

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
    onRegistrationQuotaChange: async ({ ownerUserId, deliver }) => {
      // A probe of one machine can move a pool the owner's other machines share.
      const readings = await readOwnerQuota(ownerUserId).catch((error: unknown) => {
        console.warn("Registration quota read after a probe failed", {
          errorCode: error instanceof Error ? error.name : "unknown",
        });
        return [];
      });
      for (const { registration, usage } of readings) {
        await audiences.rememberQuota(registration, usage);
        publishQuota(ownerUserId, registration, usage, deliver);
      }
    },
    onChannelCatalogChanged: (spaceId) => {
      // Who may see a Channel of this Space may have changed: read it again.
      const forgotten = audiences.forgetSpace(spaceId).catch((error: unknown) => {
        console.warn("Presence audiences of a changed Space could not be forgotten", {
          errorCode: error instanceof Error ? error.name : "unknown",
        });
      });
      options.scheduleBackground?.(forgotten);
    },
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
      const ownerUserId = session.principal.ownerUserId;
      const known = reason === "update" ? await audiences.audience(session.run.instanceId) : undefined;
      if (reason === "disconnect") await audiences.forget(session.run.instanceId);
      if (known && known.channelId === session.run.channelId && Date.now() - known.readAt < PRESENCE_AUDIENCE_TTL_MS) {
        // A status report: the card alone carries it, and every viewer's
        // client patches its Channel from the card.
        const { quota: accountQuota, read } = await audienceQuota(session.run.instanceId, known, session);
        // A held reading went out when it was read; only a new read is news.
        if (read && known.registration) publishQuota(ownerUserId, known.registration, accountQuota, deliver);
        const card = humanEnhancedPresenceFrame(session, status, offlineReason, accountQuota);
        const recipients: ChannelAgentPresenceRecipient[] = [];
        for (const userId of [ownerUserId, ...known.viewers]) {
          deliverAgentPresence(userId, session.run.channelId, card, undefined);
          recipients.push({ userId, digest: true, card: true, channel: false, immediate: [] });
        }
        scheduleAgentPresenceAcrossCells({
          env, scheduleBackground: options.scheduleBackground, runtimeSelf: options.runtimeSelf,
          channelId: session.run.channelId, reason, card: card.agent, recipients,
        });
        return;
      }
      const live = liveAgentFanout.sessions().filter(candidate => candidate.run.instanceId !== session.run.instanceId);
      const payload = await readChannel(session.run.channelId, session.principal.ownerUserId, "agent-presence",
        session.principal.spaceId);
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
      // This read is the registration's current reading; the owner's other Agents under it take it too.
      if (registration) {
        await audiences.rememberQuota(registration, accountQuota);
        publishQuota(ownerUserId, registration, accountQuota, deliver);
      }
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
      if (reason !== "disconnect") {
        await audiences.remember(session.run.instanceId, {
          channelId: session.run.channelId, spaceId: payload.channel.spaceId, readAt: Date.now(),
          viewers: visibleHumanUserIds(humanMemberIds).filter(userId => userId !== ownerUserId),
          ...(registration ? { registration } : {}), quotaCheckedThrough: reportedQuotaAt(session),
        });
      }
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

const PRESENCE_QUOTA_TTL_MS = 60_000;

/** When the Instance's own provider reading was taken, if it reported one. */
function reportedQuotaAt(session: Readonly<AgentInstanceRuntimeSession>): number {
  const at = Date.parse(session.presentation?.usage?.quotaObservedAt ?? "");
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
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
