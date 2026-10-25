
import { relayRuntimeOwnerCellName } from "./runtime-transport/runtime-cell-locator";

/**
 * The one cell that holds no product socket: work that must run beside
 * PostgreSQL runs there. Every socket lives in its owner's own cell.
 */
export const RELAY_RUNTIME_SINGLE_CELL_NAME = "cell-0";

interface DurableNamespaceLike<Id, Stub> {
  idFromName(name: string): Id;
  get(id: Id, options?: { locationHint?: DurableObjectLocationHint }): Stub;
}

/** Cloudflare's closed set of Durable Object location hints. */
const RUNTIME_LOCATION_HINTS: ReadonlySet<string> = new Set([
  "wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me",
]);

/**
 * Where Runtime cells live. A Durable Object stays where it was first created,
 * so a cell that runs PostgreSQL transactions must be created next to the
 * database: every statement is a round trip. The hint is deployment config
 * (`XMATRIX_RUNTIME_LOCATION_HINT`), and it is part of each cell's object
 * name, so changing it creates fresh cells at the new location instead of
 * reusing objects pinned to the old one.
 */
export interface RelayRuntimeCellEnv<Id, Stub> {
  RELAY_RUNTIME: DurableNamespaceLike<Id, Stub>;
  XMATRIX_RUNTIME_LOCATION_HINT?: string;
}

export function relayRuntimeLocationHint(value: unknown): DurableObjectLocationHint | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !RUNTIME_LOCATION_HINTS.has(value)) {
    throw new Error("XMATRIX_RUNTIME_LOCATION_HINT is not a Durable Object location hint");
  }
  return value as DurableObjectLocationHint;
}

/** The Durable Object name of a logical Runtime cell at the configured location. */
export function relayRuntimeCellObjectName(
  env: { XMATRIX_RUNTIME_LOCATION_HINT?: string },
  cellName: string,
): string {
  const locationHint = relayRuntimeLocationHint(env.XMATRIX_RUNTIME_LOCATION_HINT);
  return locationHint ? `${cellName}@${locationHint}` : cellName;
}

function runtimeCell<Id, Stub>(env: RelayRuntimeCellEnv<Id, Stub>, cellName: string): Stub {
  const locationHint = relayRuntimeLocationHint(env.XMATRIX_RUNTIME_LOCATION_HINT);
  const id = env.RELAY_RUNTIME.idFromName(relayRuntimeCellObjectName(env, cellName));
  return locationHint ? env.RELAY_RUNTIME.get(id, { locationHint }) : env.RELAY_RUNTIME.get(id);
}

export function relayRuntimeSingleCell<Id, Stub>(env: RelayRuntimeCellEnv<Id, Stub>): Stub {
  return runtimeCell(env, RELAY_RUNTIME_SINGLE_CELL_NAME);
}

export { relayRuntimeOwnerCellName } from "./runtime-transport/runtime-cell-locator";

/** The cells holding these users' sockets: each owner's own cell. */
export function relayRuntimeCellsForOwners<Id, Stub>(
  env: RelayRuntimeCellEnv<Id, Stub>,
  ownerUserIds: Iterable<string>,
): Stub[] {
  const names = new Set<string>();
  for (const ownerUserId of ownerUserIds) {
    const name = relayRuntimeOwnerCellName(ownerUserId);
    if (name) names.add(name);
  }
  return Array.from(names, (name) => runtimeCell(env, name));
}

/**
 * Resolves a Runtime cell by name. The name MUST come from the runtime cell
 * locator (`relayRuntimeOwnerCellName`), never from raw request data.
 */
export function relayRuntimeCellNamed<Id, Stub>(
  env: RelayRuntimeCellEnv<Id, Stub>,
  cellName: string,
): Stub {
  return runtimeCell(env, cellName);
}
