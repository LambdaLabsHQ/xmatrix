import {
  relayRuntimeCellNamed,
  relayRuntimeChannelFanout,
  relayRuntimeRouteDirectory,
  relayRuntimeSingleCell,
} from "../relay-authority-locator";
import {
  LiveDeliveryRejectedError,
  publishWithLiveDeliveryRetry,
} from "../relay-authority-live-delivery-retry";
import type { Env } from "../types";
import {
  RELAY_RUNTIME_SELECTED_CELL,
  relayRuntimeRoutingMode,
} from "./runtime-cell-locator";
import { RUNTIME_FANOUT_CELLS_PER_SCOPE } from "./runtime-channel-fanout-policy";
import {
  isRuntimeRouteDirectoryCell,
  type RuntimeRouteDirectoryCell,
} from "./runtime-route-directory-locator";

const RUNTIME_COMMITTED_EVENT_PATH = "https://relay-runtime/internal/committed-event";
const RUNTIME_CHANNEL_MESSAGE_PATH = "https://relay-runtime/internal/product/channel-message";
const RUNTIME_CHANNEL_OBSERVABLE_EVENT_PATH =
  "https://relay-runtime/internal/product/channel-observable-event";
const RUNTIME_CHANNEL_AGENT_PRESENCE_PATH =
  "https://relay-runtime/internal/product/channel-agent-presence";
const RUNTIME_DIRECTORY_LOOKUP_PATH = "https://runtime-route-directory/internal/runtime-route-directory/lookup";
const RUNTIME_FANOUT_DELIVER_PATH = "https://runtime-channel-fanout/internal/runtime-channel-fanout/deliver";
const RUNTIME_FANOUT_MEMBERS_PATH = "https://runtime-channel-fanout/internal/runtime-channel-fanout/members";
const RUNTIME_DELIVERY_URLS = [
  RUNTIME_COMMITTED_EVENT_PATH,
  RUNTIME_CHANNEL_MESSAGE_PATH,
  RUNTIME_CHANNEL_OBSERVABLE_EVENT_PATH,
  RUNTIME_CHANNEL_AGENT_PRESENCE_PATH,
] as const;
const MAX_DIRECTORY_ROUTES = 17;

/** Fanout accepts only these Runtime delivery URLs, never a caller-chosen path. */
export function isRuntimeDeliveryUrl(value: unknown): value is (typeof RUNTIME_DELIVERY_URLS)[number] {
  return typeof value === "string" && (RUNTIME_DELIVERY_URLS as readonly string[]).includes(value);
}

interface RuntimeDirectoryRoute {
  cellName: RuntimeRouteDirectoryCell;
  expiresAtMs: number;
}

interface RuntimeRouteDeliveryFailure {
  cellName: RuntimeRouteDirectoryCell;
  error: unknown;
}

/**
 * Some cells may already have broadcast before another cell rejects or sheds.
 * This error is deliberately non-retriable at the aggregate level: retries
 * were already evaluated independently for each selected cell.
 */
export class RuntimeRouteDirectoryDeliveryError extends Error {
  constructor(readonly failures: readonly RuntimeRouteDeliveryFailure[]) {
    super(`RelayRuntime committed delivery failed in ${failures.length} routed cell(s)`);
    this.name = "RuntimeRouteDirectoryDeliveryError";
  }
}

/** The Runtime cell that is publishing: never RPC to itself, or the DO queues behind this request. */
export type RuntimeLiveDeliverySelf = {
  cellName: string;
  fetch(request: Request): Promise<Response>;
};

export interface RuntimeRouteDirectoryDeliveryInput {
  env: Pick<
    Env,
    | "RELAY_RUNTIME"
    | "RELAY_RUNTIME_ROUTE_DIRECTORY"
    | "RELAY_RUNTIME_CHANNEL_FANOUT"
    | "XMATRIX_RUNTIME_CELL_MODE"
    | "XMATRIX_RUNTIME_LOCATION_HINT"
  >;
  /** The Runtime scope being delivered, from typed authority state. */
  scopeId: string;
  /** The exact committed-event JSON envelope; this module owns no payload facts. */
  payload: Record<string, unknown>;
  /** Best-effort stale repair must never delay the committed delivery path. */
  waitUntil: (task: Promise<unknown>) => void;
  self?: RuntimeLiveDeliverySelf;
}

/**
 * Delivers one committed-event envelope. Shadow mode preserves the original
 * single-cell fetch byte-for-byte and never reads the route directory. Dual
 * mode retains cell-0 for legacy product sockets, adds only validated cells
 * returned by the bounded directory, and gives each cell its own retry budget.
 */
export async function publishRuntimeCommittedEvent(
  input: RuntimeRouteDirectoryDeliveryInput,
): Promise<Response> {
  const body = JSON.stringify(input.payload);
  return publishRuntimeRouted(input, () => runtimeRequest(RUNTIME_COMMITTED_EVENT_PATH, body), "committed");
}

export async function publishRuntimeChannelMessage(input: {
  env: RuntimeRouteDirectoryDeliveryInput["env"];
  channelId: string;
  payload: Record<string, unknown>;
  waitUntil: (task: Promise<unknown>) => void;
  self?: RuntimeLiveDeliverySelf;
}): Promise<Response> {
  return publishRuntimeChannelScoped(input, RUNTIME_CHANNEL_MESSAGE_PATH, "Channel");
}

/**
 * Agent presence for Humans watching this Channel from another Runtime cell.
 * The publishing cell already delivered to its own sockets, so it is skipped:
 * an RPC back into the object that is handling the socket would queue behind it.
 */
export async function publishRuntimeChannelAgentPresence(input: {
  env: RuntimeRouteDirectoryDeliveryInput["env"];
  channelId: string;
  body: string;
  exceptCell: string;
}): Promise<void> {
  const request = () => runtimeRequest(RUNTIME_CHANNEL_AGENT_PRESENCE_PATH, input.body);
  if (await scopeUsesChannelFanout(input.env, input.channelId)) {
    await deliverThroughChannelFanout(input.env, input.channelId, request, input.exceptCell);
    if (input.exceptCell !== RELAY_RUNTIME_SELECTED_CELL &&
        relayRuntimeRoutingMode(input.env.XMATRIX_RUNTIME_CELL_MODE) === "dual") {
      await deliverToRuntimeCells({
        env: input.env,
        cells: [RELAY_RUNTIME_SELECTED_CELL],
        request,
        label: "Agent presence",
      });
    }
    return;
  }
  const cells = await runtimeCellsExcept(input.env, input.channelId, input.exceptCell);
  if (cells.length === 0) return;
  await deliverToRuntimeCells({
    env: input.env,
    cells,
    request,
    label: "Agent presence",
  });
}

async function runtimeCellsExcept(
  env: RuntimeRouteDirectoryDeliveryInput["env"],
  channelId: string,
  exceptCell: string,
): Promise<RuntimeRouteDirectoryCell[]> {
  const single = RELAY_RUNTIME_SELECTED_CELL;
  if (relayRuntimeRoutingMode(env.XMATRIX_RUNTIME_CELL_MODE) !== "dual") {
    return exceptCell === single ? [] : [single];
  }
  const directory = relayRuntimeRouteDirectory(env.RELAY_RUNTIME_ROUTE_DIRECTORY, channelId);
  const lookedUp = directory ? await lookupDirectory(directory, channelId).catch(() => undefined) : undefined;
  const targets = new Set<RuntimeRouteDirectoryCell>([
    single,
    ...(lookedUp?.routes ?? []).map((route) => route.cellName),
  ]);
  targets.delete(exceptCell as RuntimeRouteDirectoryCell);
  return [...targets];
}

export async function publishRuntimeChannelObservableEvent(input: {
  env: RuntimeRouteDirectoryDeliveryInput["env"];
  channelId: string;
  payload: { recipientUserIds: string[]; event: Record<string, unknown> };
  waitUntil: (task: Promise<unknown>) => void;
  self?: RuntimeLiveDeliverySelf;
}): Promise<Response> {
  return publishRuntimeChannelScoped(input, RUNTIME_CHANNEL_OBSERVABLE_EVENT_PATH, "Channel observable");
}

function publishRuntimeChannelScoped(
  input: {
    env: RuntimeRouteDirectoryDeliveryInput["env"];
    channelId: string;
    payload: Record<string, unknown>;
    waitUntil: (task: Promise<unknown>) => void;
    self?: RuntimeLiveDeliverySelf;
  },
  path: string,
  label: string,
): Promise<Response> {
  const body = JSON.stringify(input.payload);
  return publishRuntimeRouted(
    { env: input.env, scopeId: input.channelId, payload: input.payload, waitUntil: input.waitUntil,
      ...(input.self ? { self: input.self } : {}) },
    () => runtimeRequest(path, body),
    label,
  );
}

function runtimeRequest(url: string, body: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** The channel fanout object calls this. It never fetches the publishing cell. */
export function deliverRuntimeFanoutTargets(input: {
  env: RuntimeRouteDirectoryDeliveryInput["env"];
  cells: readonly RuntimeRouteDirectoryCell[];
  url: string;
  body: string;
  label: string;
}): Promise<Array<{ cellName: RuntimeRouteDirectoryCell; response: Response }>> {
  if (!isRuntimeDeliveryUrl(input.url) || input.cells.length === 0) return Promise.resolve([]);
  return deliverToRuntimeCells({
    env: input.env,
    cells: input.cells,
    request: () => runtimeRequest(input.url, input.body),
    label: input.label,
  });
}

function deliverToRuntimeCells(input: {
  env: RuntimeRouteDirectoryDeliveryInput["env"];
  cells: readonly RuntimeRouteDirectoryCell[];
  request: () => Request;
  label: string;
  self?: RuntimeLiveDeliverySelf;
}): Promise<Array<{ cellName: RuntimeRouteDirectoryCell; response: Response }>> {
  return Promise.all(input.cells.map(async (cellName) => {
    try {
      const response = await publishWithLiveDeliveryRetry(async () => {
        const candidate = await fetchRuntimeCell(input.env, cellName, input.request(), input.self);
        if (!candidate.ok) {
          const detail = await candidate.text().catch(() => "");
          throw new LiveDeliveryRejectedError(
            candidate.status,
            `RelayRuntime rejected ${input.label} delivery (${candidate.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
          );
        }
        return candidate;
      });
      return { cellName, response };
    } catch (error) {
      return { cellName, error };
    }
  })).then((results) => {
    const failures = results.flatMap((result): RuntimeRouteDeliveryFailure[] =>
      "error" in result ? [{ cellName: result.cellName, error: result.error }] : [],
    );
    if (failures.length > 0) throw new RuntimeRouteDirectoryDeliveryError(failures);
    return results.flatMap((result) =>
      "response" in result && result.response ? [{ cellName: result.cellName, response: result.response }] : [],
    );
  });
}

function fetchRuntimeCell(
  env: RuntimeRouteDirectoryDeliveryInput["env"],
  cellName: string,
  request: Request,
  self?: RuntimeLiveDeliverySelf,
): Promise<Response> {
  if (self && self.cellName === cellName) return self.fetch(request);
  return (cellName === RELAY_RUNTIME_SELECTED_CELL
    ? relayRuntimeSingleCell(env) : relayRuntimeCellNamed(env, cellName)).fetch(request);
}

async function publishRuntimeRouted(
  input: RuntimeRouteDirectoryDeliveryInput,
  request: () => Request,
  label: string,
): Promise<Response> {
  if (relayRuntimeRoutingMode(input.env.XMATRIX_RUNTIME_CELL_MODE) !== "dual") {
    return fetchRuntimeCell(input.env, RELAY_RUNTIME_SELECTED_CELL, request(), input.self);
  }
  const directory = relayRuntimeRouteDirectory(input.env.RELAY_RUNTIME_ROUTE_DIRECTORY, input.scopeId);
  const lookedUp = directory
    ? await lookupDirectory(directory, input.scopeId).catch(() => undefined)
    : undefined;
  // This projection cannot strand legacy sockets when absent or unavailable.
  if (lookedUp === undefined) {
    return fetchRuntimeCell(input.env, RELAY_RUNTIME_SELECTED_CELL, request(), input.self);
  }
  if (lookedUp.fanout) {
    const [fanoutSettled, results] = await Promise.all([
      deliverThroughChannelFanout(input.env, input.scopeId, request, input.self?.cellName),
      deliverToRuntimeCells({
        env: input.env,
        cells: [RELAY_RUNTIME_SELECTED_CELL],
        request,
        label,
        ...(input.self ? { self: input.self } : {}),
      }),
    ]);
    void fanoutSettled;
    const selected = results.find((result) => result.cellName === RELAY_RUNTIME_SELECTED_CELL);
    if (!selected || !("response" in selected) || !selected.response) {
      throw new RuntimeRouteDirectoryDeliveryError([{
        cellName: RELAY_RUNTIME_SELECTED_CELL,
        error: new Error("Runtime default cell did not settle"),
      }]);
    }
    return selected.response;
  }
  const targets = new Set<RuntimeRouteDirectoryCell>([
    RELAY_RUNTIME_SELECTED_CELL,
    ...lookedUp.routes.map((route) => route.cellName),
  ]);
  const results = await deliverToRuntimeCells({
    env: input.env,
    cells: [...targets],
    request,
    label,
    ...(input.self ? { self: input.self } : {}),
  });
  const selected = results.find((result) => result.cellName === RELAY_RUNTIME_SELECTED_CELL);
  if (!selected || !("response" in selected) || !selected.response) {
    throw new RuntimeRouteDirectoryDeliveryError([{
      cellName: RELAY_RUNTIME_SELECTED_CELL,
      error: new Error("Runtime default cell did not settle"),
    }]);
  }
  return selected.response;
}

interface RuntimeDirectoryLookup {
  routes: RuntimeDirectoryRoute[];
  fanout: boolean;
}

async function scopeUsesChannelFanout(
  env: RuntimeRouteDirectoryDeliveryInput["env"],
  scopeId: string,
): Promise<boolean> {
  if (relayRuntimeRoutingMode(env.XMATRIX_RUNTIME_CELL_MODE) !== "dual") return false;
  const directory = relayRuntimeRouteDirectory(env.RELAY_RUNTIME_ROUTE_DIRECTORY, scopeId);
  const lookedUp = directory ? await lookupDirectory(directory, scopeId).catch(() => undefined) : undefined;
  return lookedUp?.fanout === true;
}

async function deliverThroughChannelFanout(
  env: RuntimeRouteDirectoryDeliveryInput["env"],
  scopeId: string,
  request: () => Request,
  exceptCell: string | undefined,
): Promise<void> {
  const namespace = env.RELAY_RUNTIME_CHANNEL_FANOUT;
  const fanout = namespace ? relayRuntimeChannelFanout(namespace, scopeId, env) : undefined;
  if (!fanout) throw new Error("Runtime channel fanout is not configured");
  const sample = request();
  const response = await fanout.fetch(new Request(RUNTIME_FANOUT_DELIVER_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: sample.url,
      body: await sample.text(),
      ...(exceptCell && isRuntimeRouteDirectoryCell(exceptCell) ? { exceptCell } : {}),
    }),
  }));
  if (!response.ok) {
    throw new RuntimeRouteDirectoryDeliveryError([{
      cellName: RELAY_RUNTIME_SELECTED_CELL,
      error: new Error(`Channel fanout rejected delivery (${response.status})`),
    }]);
  }
}

async function lookupDirectory(
  directory: { fetch(request: Request): Promise<Response> },
  scopeId: string,
): Promise<RuntimeDirectoryLookup | undefined> {
  const response = await directory.fetch(new Request(RUNTIME_DIRECTORY_LOOKUP_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopeId }),
  }));
  if (!response.ok) return undefined;
  const payload: unknown = await response.json().catch(() => undefined);
  return parseDirectoryLookup(payload);
}

async function lookupFanoutMembers(
  env: RuntimeRouteDirectoryDeliveryInput["env"],
  scopeId: string,
): Promise<RuntimeDirectoryRoute[] | undefined> {
  const namespace = env.RELAY_RUNTIME_CHANNEL_FANOUT;
  const fanout = namespace ? relayRuntimeChannelFanout(namespace, scopeId, env) : undefined;
  if (!fanout) return undefined;
  const response = await fanout.fetch(new Request(RUNTIME_FANOUT_MEMBERS_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }));
  if (!response.ok) return undefined;
  const payload: unknown = await response.json().catch(() => undefined);
  return parseRouteList(payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { routes?: unknown }).routes
    : undefined, RUNTIME_FANOUT_CELLS_PER_SCOPE);
}

function parseDirectoryLookup(value: unknown): RuntimeDirectoryLookup | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { routes?: unknown; fanout?: unknown };
  const fanout = record.fanout === true;
  const routes = parseRouteList(record.routes);
  if (!routes) return fanout ? { routes: [], fanout: true } : undefined;
  return { routes, fanout };
}

function parseRouteList(routes: unknown, maxRoutes = MAX_DIRECTORY_ROUTES): RuntimeDirectoryRoute[] | undefined {
  if (!Array.isArray(routes) || routes.length > maxRoutes) return undefined;
  const unique = new Set<string>();
  const parsed: RuntimeDirectoryRoute[] = [];
  for (const item of routes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(record, "cellName") ||
      !Object.prototype.hasOwnProperty.call(record, "expiresAtMs") ||
      !isRuntimeRouteDirectoryCell(record.cellName) ||
      typeof record.expiresAtMs !== "number" ||
      !Number.isSafeInteger(record.expiresAtMs) || record.expiresAtMs <= 0 ||
      unique.has(record.cellName)
    ) return undefined;
    unique.add(record.cellName);
    parsed.push({ cellName: record.cellName, expiresAtMs: record.expiresAtMs });
  }
  return parsed;
}

/**
 * Every Runtime cell that may hold a socket in this channel: the single cell,
 * plus each cell the route directory lists for it. An unreadable directory
 * degrades to the single cell, exactly like delivery does.
 */
export async function runtimeCellsForChannel(
  env: RuntimeRouteDirectoryDeliveryInput["env"],
  channelId: string,
): Promise<{ fetch(request: Request): Promise<Response> }[]> {
  const single = relayRuntimeSingleCell(env);
  const directory = relayRuntimeRouteDirectory(env.RELAY_RUNTIME_ROUTE_DIRECTORY, channelId);
  const lookedUp = directory ? await lookupDirectory(directory, channelId).catch(() => undefined) : undefined;
  const routes = lookedUp?.fanout
    ? await lookupFanoutMembers(env, channelId).catch(() => undefined)
    : lookedUp?.routes;
  return [
    single,
    ...(routes ?? [])
      .filter((route) => route.cellName !== RELAY_RUNTIME_SELECTED_CELL)
      .map((route) => relayRuntimeCellNamed(env, route.cellName)),
  ];
}
