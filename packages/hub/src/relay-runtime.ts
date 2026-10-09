import { plainDeliveryRecord as plainObject } from "./runtime-transport/delivery-record";
import { HUMAN_HEARTBEAT_PING, HUMAN_HEARTBEAT_PONG } from "@xmatrix/protocol";
import { parseChannelTombstoneDelivery } from "./runtime-transport/channel-tombstone-delivery";
import { DurableObject } from "cloudflare:workers";
import { relayRuntimeRouteDirectory } from "./relay-authority-locator";
import {
  parseHumanChannelCatalogChangedMessage,
  parseHumanTraceAccessServerMessage,
  parseHumanWorkspaceResourceChangedMessage,
} from "@xmatrix/protocol/connections/human";
import {
  type ChannelAttentionSummary,
  type ChannelMessageNotification,
  utf8ByteLength } from "@xmatrix/protocol";
import type { Env } from "./types";
import {
  createRelayRuntimeProductAdapter,
  isProductHibernationAttachment,
  isRelayRuntimeProductConnectPath,
  RELAY_RUNTIME_CHANNEL_MESSAGE_PATH,
  RELAY_RUNTIME_CHANNEL_OBSERVABLE_EVENT_PATH,
  RELAY_RUNTIME_HUMAN_OBSERVABLE_EVENT_PATH,
  RELAY_RUNTIME_AGENT_TRACE_TERMINATE_PATH,
  RELAY_RUNTIME_MACHINE_DAEMON_CLAIM_PATH,
  RELAY_RUNTIME_MACHINE_DAEMON_WAIT_PATH,
  type RelayRuntimeProductCallbackAdapter,
  type RelayRuntimeProductPortFactory,
} from "./runtime-transport/relay-runtime-product-adapter";
import type { HumanProjectionPublishResult } from "./connections/human/registry";
import { MachineDaemonWakeSignals } from "./machine-daemon-wake-signals";
import {
  isRelayRuntimeOwnerCell,
  RELAY_RUNTIME_CELL_HEADER,
  RELAY_RUNTIME_SELECTED_CELL,
  type RelayRuntimeOwnerCell,
} from "./runtime-transport/runtime-cell-locator";
import {
  RUNTIME_ROUTE_DIRECTORY_MAX_SCOPE_IDS_PER_REQUEST,
  runtimeRouteDirectoryShardName,
  type RuntimeRouteDirectoryCell,
} from "./runtime-transport/runtime-route-directory-locator";
import { legacyClientCompatibilityAdmissionEnabled } from "./client-compatibility-gate";
import { RELAY_RUNTIME_HUMAN_PRESENCE_PATH } from "./runtime-transport/human-presence-fanout";
import { RELAY_RUNTIME_AGENT_CONTROL_SWITCH_PATH } from "./product-agent-model-effort";
import { RELAY_RUNTIME_AGENT_PRESENCE_PATH } from "./runtime-transport/agent-presence-snapshot";
import {
  parseChannelAgentPresenceDelivery,
  RELAY_RUNTIME_CHANNEL_AGENT_PRESENCE_PATH,
} from "./runtime-transport/channel-agent-presence-delivery";
import { createProductionRelayRuntimeProductPortFactory } from "./runtime-transport/production-product-port-factory";
import {
  AGENT_HOST_TRACE_MAX_EVENTS,
  AGENT_HOST_TRACE_MAX_WAIT_MS,
  agentHostTraceTimestampEpochNanoseconds,
  parseAgentHostTraceCursor,
} from "./agent-host-trace";
import type { AgentChannelLiveDeliveryInput } from "./runtime-transport/agent-instance-port";
import type { HumanChannelLiveDeliveryInput } from "./runtime-transport/human-port";

const MAX_COMMITTED_EVENT_BYTES = 64 * 1024;
const MAX_EVENT_RECIPIENTS = 1_000;
const TRACE_ACCESS_COMMITTED_EVENT_CHANNEL = "trace-access";
/** Reserved id: catalog watermarks are Space-scoped and contain no Channel facts. */
const CHANNEL_CATALOG_COMMITTED_EVENT_CHANNEL = "space-channel-catalog";
/** Reserved id: workspace-list wake-ups carry no row facts. */
const WORKSPACE_RESOURCE_COMMITTED_EVENT_CHANNEL = "workspace-resource";
export const RELAY_RUNTIME_AGENT_TRACE_PATH = "/internal/product-trace/instance-events";
export {
  RELAY_RUNTIME_CHANNEL_MESSAGE_PATH,
  RELAY_RUNTIME_HUMAN_OBSERVABLE_EVENT_PATH,
};
interface RelayRuntimeCommittedEvent {
  channelId: string;
  changeSeq: number;
  event: unknown;
  /** Exact principals authorized by Authority for this committed envelope. */
  recipientPrincipalIds?: string[];
}

function humanFanoutResponse(
  result: HumanProjectionPublishResult,
  label: string,
): Response {
      if (!result.accepted) {
        return Response.json({ error: `${label} fanout rejected: ${result.reason}` }, {
          status: result.reason === "fanout_limit" ? 429 : 400,
        });
      }
      return Response.json({
        delivered: result.delivered,
        productHumanDelivered: result.delivered,
        productHumanFailed: result.failed,
      });
}

function runtimeTransportUnavailable(kind: "product" | "Human"): Response {
  return Response.json({ error: `Relay Runtime ${kind} transport is unavailable` }, {
    status: 503,
    ...(kind === "product" ? { headers: { "cache-control": "no-store" } } : {}),
  });
}

function boundedId(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > max) return undefined;
  return normalized;
}

function observableDeliveryResponse(delivered: boolean | number): Response {
  return Response.json({ ok: true, delivered }, { headers: { "cache-control": "no-store" } });
}

async function machineDaemonRequestScope(request: Request) {
  const body = await request.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  return { ownerUserId: boundedId(body.ownerUserId), machineId: boundedId(body.machineId),
    hostId: boundedId(body.hostId) || "", waitMs: body.waitMs };
}

function parseChannelLiveDeliveryCore(input: Record<string, unknown>): AgentChannelLiveDeliveryInput | undefined {
  const update = parseChannelTombstoneDelivery(input);
  if (update === null) return undefined;
  const channelId = boundedId(input.channelId);
  const messageId = boundedId(input.messageId);
  const body = typeof input.body === "string" ? input.body : undefined;
  const sentAt = typeof input.sentAt === "string" && input.sentAt.trim() ? input.sentAt.trim() : undefined;
  const sequence = Number(input.sequence);
  const from = plainObject(input.from);
  if (!channelId || !messageId || body === undefined || !sentAt || !from ||
      !Number.isSafeInteger(sequence) || sequence < 1) {
    return undefined;
  }
  if (utf8ByteLength(body) > 64 * 1024) return undefined;
  return {
    ...update,
    channelId,
    messageId,
    sequence,
    body,
    from,
    sentAt,
    ...(typeof input.replyToMessageId === "string" && input.replyToMessageId.trim()
      ? { replyToMessageId: input.replyToMessageId.trim().slice(0, 200) }
      : {}),
    ...(plainObject(input.metadata) ? { metadata: plainObject(input.metadata)! } : {}),
    ...(Array.isArray(input.attachments) ? { attachments: input.attachments } : {}),
  };
}

function parseAgentChannelLiveDelivery(value: unknown): AgentChannelLiveDeliveryInput | undefined {
  const input = plainObject(value);
  const core = input ? parseChannelLiveDeliveryCore(input) : undefined;
  if (!input || !core) return undefined;
  return {
    ...core,
    ...(plainObject(input.replyTo) ? { replyTo: plainObject(input.replyTo)! } : {}),
    ...(Array.isArray(input.appMentions) ? { appMentions: input.appMentions } : {}),
  };
}

function parseHumanChannelLiveDelivery(value: unknown): HumanChannelLiveDeliveryInput | undefined {
  const input = plainObject(value);
  if (!input) return undefined;
  const core = parseChannelLiveDeliveryCore(input);
  if (!core) return undefined;
  const { channelId } = core;
  const recipientUserIds = Array.isArray(input.recipientUserIds)
    ? input.recipientUserIds
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim().slice(0, 200))
        .slice(0, 1_000)
    : [];
  const recipientSet = new Set(recipientUserIds);
  const recipientNotifications: Array<{
    userId: string;
    notification: ChannelMessageNotification;
  }> = Array.isArray(input.recipientNotifications)
    ? input.recipientNotifications.flatMap((candidate) => {
        const entry = plainObject(candidate);
        const notification = plainObject(entry?.notification);
        const userId = typeof entry?.userId === "string" ? entry.userId.trim().slice(0, 200) : "";
        const reason = notification?.reason;
        if (!userId || !recipientSet.has(userId) ||
            (reason !== "mention" && reason !== "reply" && reason !== "broadcast")) {
          return [];
        }
        const attention = parseChannelAttentionSummary(notification?.attention, channelId);
        if (!attention) return [];
        return [{
          userId,
          notification: {
            reason: reason as ChannelMessageNotification["reason"],
            ...(attention ? { attention } : {}),
          } as ChannelMessageNotification,
        }];
      }).slice(0, 1_000)
    : [];
  if (recipientUserIds.length === 0) return undefined;
  return {
    ...core,
    recipientUserIds,
    recipientNotifications,
    ...(typeof input.clientMessageId === "string" && input.clientMessageId.trim()
      ? { clientMessageId: input.clientMessageId.trim().slice(0, 200) }
      : {}),

  };
}

function parseChannelAttentionSummary(
  value: unknown,
  channelId: string | undefined,
): ChannelAttentionSummary | undefined {
  const input = plainObject(value);
  if (!input || !channelId || input.channelId !== channelId ||
      !Number.isSafeInteger(input.unreadAttentionCount) || Number(input.unreadAttentionCount) < 1 ||
      typeof input.updatedAt !== "string" || !input.updatedAt.trim() || input.updatedAt.length > 64) {
    return undefined;
  }
  const optionalText = (field: unknown, max = 200) =>
    typeof field === "string" && field.trim() && field.length <= max ? field : undefined;
  const triggerKinds = Array.isArray(input.triggerKinds) && input.triggerKinds.length <= 4 &&
      input.triggerKinds.every((kind) =>
        kind === "mention" || kind === "reply" || kind === "quote" || kind === "broadcast")
    ? [...new Set(input.triggerKinds)] as ChannelAttentionSummary["triggerKinds"]
    : undefined;
  const primaryTriggerKind = input.primaryTriggerKind === "mention" ||
      input.primaryTriggerKind === "reply" || input.primaryTriggerKind === "quote" ||
      input.primaryTriggerKind === "broadcast"
    ? input.primaryTriggerKind
    : undefined;
  const lastMessageSequence = Number.isSafeInteger(input.lastMessageSequence) &&
      Number(input.lastMessageSequence) >= 1
    ? Number(input.lastMessageSequence)
    : undefined;
  return {
    channelId,
    unreadAttentionCount: Number(input.unreadAttentionCount),
    updatedAt: input.updatedAt,
    ...(optionalText(input.lastAttentionAt, 64) ? { lastAttentionAt: String(input.lastAttentionAt) } : {}),
    ...(optionalText(input.lastMessageId) ? { lastMessageId: String(input.lastMessageId) } : {}),
    ...(lastMessageSequence !== undefined ? { lastMessageSequence } : {}),
    ...(primaryTriggerKind ? { primaryTriggerKind } : {}),
    ...(triggerKinds ? { triggerKinds } : {}),
  };
}

function boundedPrincipalId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || utf8ByteLength(normalized) > 200) return undefined;
  return normalized;
}

function isExactObject(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  const expected = new Set(keys);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

function relayRuntimeProductFactoryFromEnv(
  env: Env,
  scheduleBackground: (task: Promise<unknown>) => void,
  runtimeSelf: { cellName: () => string; fetch(request: Request): Promise<Response> },
  storage: DurableObjectStorage,
): RelayRuntimeProductPortFactory | undefined {
  // Every product port answers from PostgreSQL.
  if (!env.RELAY_POSTGRES) return undefined;
  try {
    return createProductionRelayRuntimeProductPortFactory(env, { scheduleBackground, runtimeSelf, storage });
  } catch {
    return undefined;
  }
}

/** The sole live relay runtime Durable Object implementation. */

const RELAY_RUNTIME_OWNER_CELL_KEY = "runtime-owner-cell";

export class RelayRuntimeLive extends DurableObject<Env> {
  private readonly productAdapter: RelayRuntimeProductCallbackAdapter | undefined;
  /** Set when this object is a user's own cell; only those register occupancy. */
  private ownerCell: RelayRuntimeOwnerCell | undefined;
  /** Channel scopes this owner cell has registered for its product sockets. */
  private readonly productOccupiedScopes = new Set<string>();
  private readonly machineDaemonWakeSignals = new MachineDaemonWakeSignals();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The web heartbeat is answered without waking this object (and without
    // ending its hibernation), so the web can find a dead socket in seconds.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HUMAN_HEARTBEAT_PING, HUMAN_HEARTBEAT_PONG));
    const productFactory = relayRuntimeProductFactoryFromEnv(
      env,
      (task) => ctx.waitUntil(task),
      {
        cellName: () => this.ownerCell ?? RELAY_RUNTIME_SELECTED_CELL,
        fetch: request => this.fetch(request),
      },
      ctx.storage,
    );
    this.productAdapter = productFactory
      ? createRelayRuntimeProductAdapter(ctx, productFactory, {
          allowLegacyProtocol: legacyClientCompatibilityAdmissionEnabled(env),
        })
      : undefined;
    for (const socket of this.ctx.getWebSockets()) {
      if (this.productAdapter?.owns(socket)) continue;
      // Product-domain sockets are restored (or closed) by the product adapter.
      // Do not treat an expired-but-live Machine Daemon attachment as a generic
      // Runtime route failure; that immediately drops hub control after wake.
      if (isProductHibernationAttachment(socket.deserializeAttachment())) continue;
      socket.close(1008, "Invalid hibernation attachment");
    }
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get(RELAY_RUNTIME_OWNER_CELL_KEY);
      if (isRelayRuntimeOwnerCell(stored)) this.ownerCell = stored;
      // Hibernation keeps sockets but not this set: register them again,
      // which also renews their leases.
      this.refreshProductOccupancy();
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.routeFetch(request);
  }

  private async routeFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (isRelayRuntimeProductConnectPath(url.pathname)) {
      if (!this.productAdapter) return runtimeTransportUnavailable("product");
      await this.learnOwnerCell(request.headers.get(RELAY_RUNTIME_CELL_HEADER));
      return this.productAdapter.fetch(request);
    }
    if (request.method === "GET" && url.pathname === RELAY_RUNTIME_HUMAN_PRESENCE_PATH) {
      return Response.json({
        sessions: this.productAdapter?.liveHumanSessions() ?? [],
      }, {
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (request.method === "GET" && url.pathname === RELAY_RUNTIME_AGENT_PRESENCE_PATH) {
      const filterNames = ["agentId", "runId", "instanceId", "channelId"] as const;
      const filters = {
        agentId: boundedId(url.searchParams.get("agentId"), 200),
        runId: boundedId(url.searchParams.get("runId"), 200),
        instanceId: boundedId(url.searchParams.get("instanceId"), 200),
        channelId: boundedId(url.searchParams.get("channelId"), 180),
      };
      const filterRequested = filterNames.some((name) => url.searchParams.has(name));
      if (filterRequested && filterNames.some((name) => !filters[name])) {
        return Response.json({ error: "Incomplete Agent presence binding" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      /* Filter inside the snapshot build, not after it: a bound read is one
         Agent message's send path, and materializing every other live session
         first is work this single cell does for nobody. */
      const sessions = this.productAdapter?.liveAgentSessions(
        filterRequested
          ? {
              agentId: filters.agentId!,
              runId: filters.runId!,
              instanceId: filters.instanceId!,
              channelId: filters.channelId!,
            }
          : undefined,
      ) ?? [];
      return Response.json({ sessions }, {
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (request.method === "GET" && url.pathname === RELAY_RUNTIME_AGENT_TRACE_PATH) {
      if (!this.productAdapter) {
        return Response.json({
          availability: "unavailable",
          complete: false,
          events: [],
          reason: "host_offline",
        }, { status: 200, headers: { "cache-control": "private, no-store" } });
      }
      const instanceId = boundedId(url.searchParams.get("instanceId"));
      const maxEvents = Number(url.searchParams.get("limit") || "100");
      const since = url.searchParams.get("since") || undefined;
      const before = url.searchParams.get("before") || undefined;
      const waitMs = url.searchParams.has("waitMs") ? Number(url.searchParams.get("waitMs")) : undefined;
      if (!instanceId || !Number.isSafeInteger(maxEvents) || maxEvents < 1 ||
          maxEvents > AGENT_HOST_TRACE_MAX_EVENTS ||
          (since !== undefined && agentHostTraceTimestampEpochNanoseconds(since) === undefined) ||
          (before !== undefined && parseAgentHostTraceCursor(before) === undefined) ||
          (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 0 ||
            waitMs > AGENT_HOST_TRACE_MAX_WAIT_MS))) {
        return Response.json({ error: "Invalid Agent host trace request" }, {
          status: 400,
          headers: { "cache-control": "private, no-store" },
        });
      }
      return Response.json(
        await this.productAdapter.requestAgentTraceHistory(instanceId, { maxEvents, since, before, waitMs }),
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_AGENT_CONTROL_SWITCH_PATH) {
      const payload = plainObject(await request.json().catch(() => undefined));
      const channelId = boundedId(payload?.channelId, 180);
      const target = boundedId(payload?.target, 200);
      const kind = payload?.kind === "model" || payload?.kind === "effort" ? payload.kind : undefined;
      const value = payload?.value === undefined ? undefined : boundedId(payload.value, 128);
      if (!channelId || !target || !kind || (payload?.value !== undefined && !value)) {
        return Response.json({ error: "Invalid Agent Instance control switch request" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      if (!this.productAdapter) {
        // No live socket in this cell means no Instance to ask, not an outage.
        return Response.json({ outcome: { status: "no_instance" } }, {
          headers: { "cache-control": "no-store" },
        });
      }
      return Response.json({
        outcome: await this.productAdapter.switchAgentInstanceControl({
          channelId,
          target,
          kind,
          ...(value ? { value } : {}),
        }),
      }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_AGENT_TRACE_TERMINATE_PATH) {
      const instanceId = boundedId(url.searchParams.get("instanceId"));
      if (!instanceId) {
        return Response.json({ error: "Invalid Agent Instance trace terminal request" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      // A fixed vocabulary: the caller names why, never the text an Agent sees.
      const notified = this.productAdapter?.terminateAgentTraceSession(
        instanceId,
        url.searchParams.get("reason") === "ended_on_host"
          ? "Agent run ended on its authenticated host"
          : "Stopped from xMatrix web",
      ) ?? false;
      return Response.json({ ok: true, notified }, {
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_CHANNEL_MESSAGE_PATH) {
      // One committed message arrives once and fans out to both audiences
      // here: Agent host sockets unconditionally, Human product subscribers
      // when the payload names recipients. Splitting these into two Runtime
      // invocations doubled this object's input queue for every message.
      if (!this.productAdapter) return runtimeTransportUnavailable("product");
      const body = await request.json<Record<string, unknown>>().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "Invalid channel message delivery" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      const agentDelivery = parseAgentChannelLiveDelivery(body);
      if (!agentDelivery) {
        return Response.json({ error: "Invalid channel message delivery" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      const wantsHumanDelivery = Array.isArray(body.recipientUserIds) && body.recipientUserIds.length > 0;
      const humanDelivery = wantsHumanDelivery ? parseHumanChannelLiveDelivery(body) : undefined;
      if (wantsHumanDelivery && !humanDelivery) {
        return Response.json({ error: "Invalid channel message delivery" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      const agent = this.productAdapter.deliverAgentChannelMessage(agentDelivery);
      const human = humanDelivery
        ? this.productAdapter.deliverHumanChannelMessage(humanDelivery)
        : undefined;
      return Response.json({ agent, ...(human !== undefined ? { human } : {}) }, {
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_CHANNEL_AGENT_PRESENCE_PATH) {
      if (!this.productAdapter) return runtimeTransportUnavailable("product");
      const delivery = parseChannelAgentPresenceDelivery(await request.json().catch(() => undefined));
      if (!delivery) {
        return Response.json({ error: "Invalid channel agent presence delivery" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      return observableDeliveryResponse(this.productAdapter.deliverChannelAgentPresence(delivery));
    }
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_HUMAN_OBSERVABLE_EVENT_PATH) {
      if (!this.productAdapter) return runtimeTransportUnavailable("product");
      const body = await request.json<Record<string, unknown>>().catch(() => null);
      const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
      const event = body?.event && typeof body.event === "object" && !Array.isArray(body.event)
        ? body.event as import("@xmatrix/protocol").ObservabilityEvent
        : null;
      if (!userId || !event || typeof event.type !== "string" || typeof event.id !== "string") {
        return Response.json({ error: "Invalid Human observable event delivery" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      const delivered = this.productAdapter.deliverHumanObservableEvent(userId, event);
      return observableDeliveryResponse(delivered);
    }
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_CHANNEL_OBSERVABLE_EVENT_PATH) {
      if (!this.productAdapter) return runtimeTransportUnavailable("product");
      const body = await request.json<Record<string, unknown>>().catch(() => null);
      const recipientUserIds = Array.isArray(body?.recipientUserIds)
        ? body.recipientUserIds
        : null;
      const event = body?.event && typeof body.event === "object" && !Array.isArray(body.event)
        ? body.event as import("@xmatrix/protocol").ObservabilityEvent
        : null;
      if (!recipientUserIds || recipientUserIds.length > MAX_EVENT_RECIPIENTS ||
          recipientUserIds.some((userId) => typeof userId !== "string" || !userId.trim()) ||
          !event || typeof event.type !== "string" || typeof event.id !== "string") {
        return Response.json({ error: "Invalid Channel observable event delivery" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      let delivered = 0;
      for (const userId of new Set(recipientUserIds as string[])) {
        if (this.productAdapter.deliverHumanObservableEvent(userId, event)) delivered += 1;
      }
      return observableDeliveryResponse(delivered);
    }
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_MACHINE_DAEMON_CLAIM_PATH) {
      const { ownerUserId, machineId, hostId } = await machineDaemonRequestScope(request);
      if (!ownerUserId || !machineId) {
        return Response.json({ error: "Invalid Machine Daemon claim scope" }, {
          status: 400,
          headers: { "cache-control": "no-store" },
        });
      }
      if (!this.productAdapter) return runtimeTransportUnavailable("product");
      this.machineDaemonWakeSignals.wake(ownerUserId, machineId, hostId);
      return Response.json(
        await this.productAdapter.claimPendingMachineDaemonCommands({
          ownerUserId,
          machineId,
          hostId,
        }),
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_MACHINE_DAEMON_WAIT_PATH) {
      const { ownerUserId, machineId, hostId, waitMs: rawWaitMs } = await machineDaemonRequestScope(request);
      const waitMs = Number(rawWaitMs);
      if (!ownerUserId || !machineId || !Number.isSafeInteger(waitMs) ||
          waitMs < 1 || waitMs > 25_000) return Response.json({ error: "Invalid Machine Daemon wait scope" }, {
        status: 400, headers: { "cache-control": "no-store" },
      });
      const woken = await this.machineDaemonWakeSignals.wait(ownerUserId, machineId, hostId, waitMs);
      return Response.json({ woken }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/internal/health") {
      return Response.json({
        cellId: "cell-0",
        connections: this.ctx.getWebSockets().length,
        persistence: "hibernation-attachments-only",
      });
    }
    if (request.method === "POST" && url.pathname === "/internal/committed-event") {
      return this.deliverCommittedEvent(request);
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.productAdapter?.owns(socket)) {
      socket.close(1008, "Runtime accepts only product sockets");
      return;
    }
    await this.productAdapter.webSocketMessage(socket, message);
    this.refreshProductOccupancy();
  }

  async webSocketClose(socket: WebSocket, code?: number, reason?: string, wasClean?: boolean): Promise<void> {
    if (!this.productAdapter?.owns(socket)) return;
    await this.productAdapter.webSocketClose(socket, code, reason, wasClean);
    this.refreshProductOccupancy();
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    if (this.productAdapter?.owns(socket)) {
      await this.productAdapter.webSocketError(socket);
      return;
    }
    socket.close(1011, "Runtime socket error");
  }

  /** The Worker names the owner cell it routed a socket to; remember it. */
  private async learnOwnerCell(header: string | null): Promise<void> {
    if (!isRelayRuntimeOwnerCell(header) || this.ownerCell === header) return;
    this.ownerCell = header;
    await this.ctx.storage.put(RELAY_RUNTIME_OWNER_CELL_KEY, header);
  }

  /**
   * Keep the route directory listing this owner cell for exactly the channels
   * its product sockets are in, so channel deliveries and presence reads find
   * it. Only the difference is written. The single cell needs no entry: every
   * channel delivery already reaches it.
   */
  private refreshProductOccupancy(): void {
    if (!this.ownerCell || !this.productAdapter) return;
    const occupied = new Set(this.productAdapter.occupiedChannelIds());
    const added = [...occupied].filter((scopeId) => !this.productOccupiedScopes.has(scopeId));
    const vacated = [...this.productOccupiedScopes].filter((scopeId) => !occupied.has(scopeId));
    for (const scopeId of added) this.productOccupiedScopes.add(scopeId);
    for (const scopeId of vacated) this.productOccupiedScopes.delete(scopeId);
    if (added.length > 0) this.scheduleRouteDirectoryMutation("register", this.ownerCell, added);
    if (vacated.length > 0) this.scheduleRouteDirectoryMutation("unregister", this.ownerCell, vacated);
  }

  private scheduleRouteDirectoryMutation(
    action: "register" | "unregister",
    cellName: RuntimeRouteDirectoryCell,
    scopeIds: readonly string[],
  ): void {
    if (scopeIds.length === 0 || !this.env.RELAY_RUNTIME_ROUTE_DIRECTORY) return;
    const task = this.mutateRouteDirectory(action, cellName, scopeIds).catch((error: unknown) => {
      console.error(`Runtime route-directory ${action} failed`, error);
    });
    try {
      this.ctx.waitUntil(task);
    } catch (error) {
      // A test or platform shim may refuse task registration. The socket path
      // remains independent of this replaceable delivery projection.
      console.error(`Runtime route-directory ${action} scheduling failed`, error);
    }
  }

  private async mutateRouteDirectory(
    action: "register" | "unregister",
    cellName: RuntimeRouteDirectoryCell,
    scopeIds: readonly string[],
  ): Promise<void> {
    const directories = new Map<string, { directory: DurableObjectStub; scopeIds: string[] }>();
    for (const scopeId of scopeIds) {
      const shardName = runtimeRouteDirectoryShardName(scopeId);
      const directory = relayRuntimeRouteDirectory(this.env.RELAY_RUNTIME_ROUTE_DIRECTORY, scopeId);
      if (!shardName || !directory) continue;
      const grouped = directories.get(shardName);
      if (grouped) {
        grouped.scopeIds.push(scopeId);
      } else {
        directories.set(shardName, { directory, scopeIds: [scopeId] });
      }
    }
    await Promise.all(Array.from(directories.values(), async ({ directory, scopeIds: scoped }) => {
      for (let offset = 0; offset < scoped.length; offset += RUNTIME_ROUTE_DIRECTORY_MAX_SCOPE_IDS_PER_REQUEST) {
        const response = await directory.fetch(`https://runtime-route-directory/internal/runtime-route-directory/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cellName,
            scopeIds: scoped.slice(offset, offset + RUNTIME_ROUTE_DIRECTORY_MAX_SCOPE_IDS_PER_REQUEST),
          }),
        });
        if (!response.ok) {
          throw new Error(`Route directory ${action} rejected with ${response.status}`);
        }
      }
    }));
  }

  private async deliverCommittedEvent(request: Request): Promise<Response> {
    const encoded = await request.arrayBuffer();
    if (encoded.byteLength === 0 || encoded.byteLength > MAX_COMMITTED_EVENT_BYTES) {
      return Response.json({ error: "Committed event exceeds runtime frame budget" }, { status: 413 });
    }
    let payload: RelayRuntimeCommittedEvent;
    try {
      payload = JSON.parse(new TextDecoder().decode(encoded)) as RelayRuntimeCommittedEvent;
    } catch {
      return Response.json({ error: "Invalid committed event" }, { status: 400 });
    }
    const channelId = boundedId(payload.channelId);
    const channelCatalogChangedEvent = parseHumanChannelCatalogChangedMessage(payload.event);
    const claimedChannelCatalogChangedEvent = payload.event !== null &&
      typeof payload.event === "object" && !Array.isArray(payload.event) &&
      (payload.event as { type?: unknown }).type === "space_channel_catalog_changed";
    const workspaceResourceChangedEvent = parseHumanWorkspaceResourceChangedMessage(payload.event);
    const claimedWorkspaceResourceChangedEvent = payload.event !== null &&
      typeof payload.event === "object" && !Array.isArray(payload.event) &&
      (payload.event as { type?: unknown }).type === "workspace_resource_changed";
    const traceAccessEvent = parseHumanTraceAccessServerMessage(payload.event);
    const claimedTraceAccessEvent = payload.event !== null && typeof payload.event === "object" &&
      !Array.isArray(payload.event) &&
      ((payload.event as { type?: unknown }).type === "trace_access_requested" ||
       (payload.event as { type?: unknown }).type === "trace_access_updated");
    if (!channelId || !Number.isSafeInteger(payload.changeSeq) || payload.changeSeq < 0) {
      return Response.json({ error: "Invalid committed event envelope" }, { status: 400 });
    }
    if (claimedTraceAccessEvent && !traceAccessEvent) {
      return Response.json({ error: "Invalid trace access committed event" }, { status: 400 });
    }
    if (claimedChannelCatalogChangedEvent && !channelCatalogChangedEvent) {
      return Response.json({ error: "Invalid Channel catalog committed event" }, { status: 400 });
    }
    if (claimedWorkspaceResourceChangedEvent && !workspaceResourceChangedEvent) {
      return Response.json({ error: "Invalid workspace resource committed event" }, { status: 400 });
    }
    const recipientPrincipalIds = this.boundedRecipientSet(payload.recipientPrincipalIds);
    if (recipientPrincipalIds === null) {
      return Response.json({ error: "Invalid committed event recipients" }, { status: 400 });
    }
    if (channelCatalogChangedEvent) {
      const exactEnvelope = isExactObject(payload, [
        "channelId", "changeSeq", "event", "recipientPrincipalIds",
      ]);
      if (!exactEnvelope || channelId !== CHANNEL_CATALOG_COMMITTED_EVENT_CHANNEL ||
          payload.changeSeq !== channelCatalogChangedEvent.revision ||
          !recipientPrincipalIds || recipientPrincipalIds.size === 0) {
        return Response.json({ error: "Invalid Channel catalog committed event" }, { status: 400 });
      }
      if (!this.productAdapter) return runtimeTransportUnavailable("Human");
      const result = this.productAdapter.publishHumanChannelCatalogChanged(
        channelCatalogChangedEvent,
        Array.from(recipientPrincipalIds),
      );
      return humanFanoutResponse(result, "Channel catalog");
    }
    if (workspaceResourceChangedEvent) {
      const exactEnvelope = isExactObject(payload, [
        "channelId", "changeSeq", "event", "recipientPrincipalIds",
      ]);
      if (!exactEnvelope || channelId !== WORKSPACE_RESOURCE_COMMITTED_EVENT_CHANNEL ||
          payload.changeSeq !== workspaceResourceChangedEvent.revision ||
          !recipientPrincipalIds || recipientPrincipalIds.size === 0) {
        return Response.json({ error: "Invalid workspace resource committed event" }, { status: 400 });
      }
      if (!this.productAdapter) return runtimeTransportUnavailable("Human");
      const result = this.productAdapter.publishHumanWorkspaceResourceChanged(
        workspaceResourceChangedEvent,
        Array.from(recipientPrincipalIds),
      );
      return humanFanoutResponse(result, "Workspace resource");
    }
    if (traceAccessEvent) {
      const expectedRecipients = new Set([
        traceAccessEvent.grant.ownerUserId,
        traceAccessEvent.grant.viewerUserId,
      ]);
      const exactEnvelope = isExactObject(payload, [
        "channelId", "changeSeq", "event", "recipientPrincipalIds",
      ]);
      if (!exactEnvelope || channelId !== TRACE_ACCESS_COMMITTED_EVENT_CHANNEL ||
          payload.changeSeq !== traceAccessEvent.grant.version ||
          !recipientPrincipalIds || !Array.isArray(payload.recipientPrincipalIds) ||
          payload.recipientPrincipalIds.length !== recipientPrincipalIds.size ||
          !sameStringSet(recipientPrincipalIds, expectedRecipients)) {
        return Response.json({ error: "Invalid trace access committed event" }, { status: 400 });
      }
      if (!this.productAdapter) return runtimeTransportUnavailable("Human");
      const result = this.productAdapter.publishHumanTraceAccess(traceAccessEvent);
      if (!result.accepted) {
        return Response.json({ error: `Trace access fanout rejected: ${result.reason}` }, {
          status: result.reason === "fanout_limit" ? 429 : 400,
        });
      }
      if (result.failed > 0) {
        return Response.json({
          error: "Trace access fanout did not reach every matched Human session",
          delivered: result.delivered,
          productHumanDelivered: result.delivered,
          productHumanFailed: result.failed,
        }, { status: 503 });
      }
      return Response.json({
        delivered: result.delivered,
        productHumanDelivered: result.delivered,
        productHumanFailed: result.failed,
      });
    }
    return Response.json({ error: "Unsupported committed event" }, { status: 400 });
  }

  private boundedRecipientSet(value: unknown): Set<string> | undefined | null {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_EVENT_RECIPIENTS) return null;
    const recipients = new Set<string>();
    for (const candidate of value) {
      const recipient = boundedPrincipalId(candidate);
      if (!recipient) return null;
      recipients.add(recipient);
    }
    if (recipients.size === 0) return null;
    return recipients;
  }
}
