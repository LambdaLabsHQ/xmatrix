import { runtimeDeliveryFetchIngress, withRuntimeDeliveryIngress } from "./runtime-transport/runtime-delivery-diagnostics";
import { TURN_RETRY_RUNTIME_PATH } from "./agent-turn-retry-policy";
import { plainDeliveryRecord as plainObject } from "./runtime-transport/delivery-record";
import { reportError, sendErrorReports } from "@xmatrix/protocol/error-reporting";
import { HUMAN_HEARTBEAT_PING, HUMAN_HEARTBEAT_PONG } from "@xmatrix/protocol";
import { parseAgentChannelLiveDelivery, parseHumanChannelLiveDelivery } from "./runtime-transport/channel-live-delivery";
import { DurableObject } from "cloudflare:workers";
import {
  parseHumanChannelCatalogChangedMessage,
  parseHumanTraceAccessServerMessage,
  parseHumanWorkspaceResourceChangedMessage,
} from "@xmatrix/protocol/connections/human";
import { utf8ByteLength } from "@xmatrix/protocol";
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
  relayRuntimeOwnerCellName,
  type RelayRuntimeOwnerCell,
} from "./runtime-transport/runtime-cell-locator";
import type { RuntimeSocketAdmission } from "./runtime-transport/runtime-socket-admission";
import { runAsRuntimeCell, type RuntimeLiveDeliverySelf } from "./runtime-transport/runtime-principal-delivery";
import { legacyClientCompatibilityAdmissionEnabled } from "./client-compatibility-gate";
import { RELAY_RUNTIME_HUMAN_PRESENCE_PATH } from "./runtime-transport/human-presence-fanout";
import { RELAY_RUNTIME_AGENT_CONTROL_SWITCH_PATH, RELAY_RUNTIME_AGENT_SWITCH_CONTINUATION_PATH } from "./product-agent-model-effort";
import { RELAY_RUNTIME_AGENT_PRESENCE_PATH } from "./runtime-transport/agent-presence-snapshot";
import {
  parseChannelAgentPresenceDelivery,
  RELAY_RUNTIME_CHANNEL_AGENT_PRESENCE_PATH,
} from "./runtime-transport/channel-agent-presence-delivery";
import { createProductionRelayRuntimeProductPortFactory } from "./runtime-transport/production-product-port-factory";
import {
  AGENT_HOST_TRACE_MAX_EVENTS,
  AGENT_HOST_TRACE_MAX_WAIT_MS,
  validAgentHostTraceSince,
  parseAgentHostTraceCursor,
} from "./agent-host-trace";
import { answerHarnessReleaseWatch, RELAY_RUNTIME_HARNESS_RELEASE_WATCH_PATH } from "./harness-release-watch";
import { analyticsWorkerVersion } from "./analytics-sampling";

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

const RELAY_RUNTIME_OWNER_CELL_KEY = "runtime-owner-cell";

/** The sole live relay runtime Durable Object implementation. */
export class RelayRuntimeLive extends DurableObject<Env> {
  /** Built once the cell knows whose it is; every event waits for that. */
  private productAdapter: RelayRuntimeProductCallbackAdapter | undefined;
  /** Set when this object is a user's own cell: the only cells that hold product sockets. */
  private ownerCell: RelayRuntimeOwnerCell | undefined;
  /** This cell as a publisher; it takes the owner's name once the cell learns whose it is. */
  private readonly deliverySelf: RuntimeLiveDeliverySelf = {
    cellName: RELAY_RUNTIME_SELECTED_CELL,
    fetch: (request: Request) => this.fetch(request),
  };
  private readonly machineDaemonWakeSignals = new MachineDaemonWakeSignals();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The heartbeat of the web and of Agent Instances is answered without waking
    // this object (and without ending its hibernation), so a dead socket is
    // found in seconds and an idle one costs nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HUMAN_HEARTBEAT_PING, HUMAN_HEARTBEAT_PONG));
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get(RELAY_RUNTIME_OWNER_CELL_KEY);
      if (isRelayRuntimeOwnerCell(stored)) this.ownerCell = this.deliverySelf.cellName = stored;
      // Sockets come back from hibernation only once the cell knows whose it
      // is: each is admitted as it is restored, or closed before it is served.
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
            admit: (ownerUserId) => this.admit(ownerUserId),
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
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.asCell(runtimeDeliveryFetchIngress(request), async () => {
      try {
        return await this.routeFetch(request);
      } catch (error) {
        // Record the receiving stack before the platform transports the exception
        // to another DO. A failed delivery may already have reached some sockets.
        try {
          reportError(error, { operation: "RelayRuntime.fetch" });
          this.ctx.waitUntil(sendErrorReports());
        } catch {
          // Reporting must not replace the originating delivery failure.
        }
        throw error;
      }
    });
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
      const receivedOrder = url.searchParams.get("order") === "received";
      const since = url.searchParams.get("since") || undefined;
      const before = url.searchParams.get("before") || undefined;
      const waitMs = url.searchParams.has("waitMs") ? Number(url.searchParams.get("waitMs")) : undefined;
      if ((url.searchParams.has("order") && !receivedOrder) || !instanceId || !Number.isSafeInteger(maxEvents) || maxEvents < 1 ||
          maxEvents > AGENT_HOST_TRACE_MAX_EVENTS ||
          (since !== undefined && !validAgentHostTraceSince(since, receivedOrder)) ||
          (before !== undefined && parseAgentHostTraceCursor(before, receivedOrder) === undefined) ||
          (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || waitMs < 0 ||
            waitMs > AGENT_HOST_TRACE_MAX_WAIT_MS))) {
        return Response.json({ error: "Invalid Agent host trace request" }, {
          status: 400,
          headers: { "cache-control": "private, no-store" },
        });
      }
      return Response.json(
        await this.productAdapter.requestAgentTraceHistory(instanceId, { maxEvents, since, before, waitMs, receivedOrder }),
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    if (request.method === "POST" && url.pathname === TURN_RETRY_RUNTIME_PATH) {
      const payload = plainObject(await request.json().catch(() => undefined));
      const message = plainObject(payload?.message);
      if (!payload || !["runId", "instanceId", "ownerUserId", "channelId"].every(key => boundedId(payload[key], 300)) ||
          !message || message.type !== "agent_turn_retry_decision" ||
          message.action !== "stop" ||
          !["requestId", "operationId", "threadId", "turnId", "attemptToken"].every(key => boundedId(message[key], 160)) ||
          message.input !== undefined)
        return Response.json({ error: "Invalid retry delivery" }, { status: 400 });
      return Response.json({ delivered: this.productAdapter?.deliverAgentTurnRetry(payload as unknown as
        Parameters<RelayRuntimeProductCallbackAdapter["deliverAgentTurnRetry"]>[0]) ?? false });
    }
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_AGENT_SWITCH_CONTINUATION_PATH) {
      const payload = plainObject(await request.json().catch(() => undefined));
      const channelId = boundedId(payload?.channelId, 180);
      const instanceId = boundedId(payload?.instanceId, 200);
      const requestIds = Array.isArray(payload?.requestIds) && payload.requestIds.length > 0 && payload.requestIds.length <= 16
        ? payload.requestIds.map((id) => boundedId(id, 200)) : [];
      const prompt = typeof payload?.prompt === "string" && payload.prompt.length <= 4_000 ? payload.prompt : undefined;
      if (!channelId || !instanceId || !prompt || requestIds.length === 0 || requestIds.some((id) => !id)) {
        return Response.json({ error: "Invalid switch continuation" }, { status: 400, headers: { "cache-control": "no-store" } });
      }
      return Response.json({ delivered: this.productAdapter?.deliverSwitchContinuation({
        channelId, instanceId, requestIds: requestIds as string[], prompt }) ?? false },
      { headers: { "cache-control": "no-store" } });
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
      // here: the Channel's Agent Instances when this cell holds them, Human
      // product subscribers when the payload names recipients. Splitting these
      // into two Runtime invocations doubled this object's input queue for
      // every message.
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
      // Only a cell holding the Channel's Instances serves them; a publisher
      // that predates the plan names no share and is served as before.
      const agent = body.instances === false
        ? { matched: 0, delivered: 0, interrupted: 0 }
        : this.productAdapter.deliverAgentChannelMessage(agentDelivery);
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
    if (request.method === "POST" && url.pathname === RELAY_RUNTIME_HARNESS_RELEASE_WATCH_PATH) {
      return answerHarnessReleaseWatch(this.env);
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
    // The release lets a caller tell a cell not yet restarted on its deploy from a missing route.
    return Response.json({ error: "Not found", workerVersion: analyticsWorkerVersion(this.env) }, { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.asCell("socket_message", async () => {
      if (!this.productAdapter?.owns(socket)) {
        socket.close(1008, "Runtime accepts only product sockets");
        return;
      }
      await this.productAdapter.webSocketMessage(socket, message);
    });
  }

  async webSocketClose(socket: WebSocket, code?: number, reason?: string, wasClean?: boolean): Promise<void> {
    return this.asCell("socket_close", async () => {
      if (!this.productAdapter?.owns(socket)) return;
      await this.productAdapter.webSocketClose(socket, code, reason, wasClean);
    });
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    return this.asCell("socket_error", async () => {
      if (this.productAdapter?.owns(socket)) {
        await this.productAdapter.webSocketError(socket);
        return;
      }
      socket.close(1011, "Runtime socket error");
    });
  }

  /**
   * Handles one event as this cell's work: what it publishes, however deep in
   * the code that commits it, serves this cell's own sockets locally instead
   * of calling back into the cell, where it would wait behind this event.
   */
  private asCell<T>(ingress: Parameters<typeof withRuntimeDeliveryIngress>[0], operation: () => Promise<T>): Promise<T> {
    return withRuntimeDeliveryIngress(ingress, () => runAsRuntimeCell(this.deliverySelf, operation));
  }

  /** The Worker names the owner cell it routed a socket to; remember it. */
  private async learnOwnerCell(header: string | null): Promise<void> {
    if (!isRelayRuntimeOwnerCell(header) || this.ownerCell === header) return;
    this.ownerCell = this.deliverySelf.cellName = header;
    await this.ctx.storage.put(RELAY_RUNTIME_OWNER_CELL_KEY, header);
  }

  /**
   * Whether this cell may hold a socket of `ownerUserId`. Only a user's own
   * cell holds product sockets, and only theirs: a delivery for a person then
   * reaches every socket of theirs by reaching their cell. A socket that named
   * no owner reached the single cell, as only clients older than owner
   * routing (1.0.0) do.
   */
  private admit(ownerUserId: string): RuntimeSocketAdmission {
    if (!this.ownerCell) return "upgrade_required";
    return relayRuntimeOwnerCellName(ownerUserId) === this.ownerCell ? "admitted" : "foreign_cell";
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
