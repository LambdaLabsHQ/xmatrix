
import { relayRuntimeOwnerCellName } from "./runtime-transport/runtime-cell-locator";
import {
  isRuntimeRouteDirectoryScopeId,
  runtimeRouteDirectoryShardName,
} from "./runtime-transport/runtime-route-directory-locator";

/**
 * Runtime socket cells are selected by owner-principal hash under the
 * partitioning ADR, and channel fanout becomes multi-cell — a single-stub
 * resolver cannot express that shape, so Runtime call sites reference this
 * greppable single-cell name instead of declaring scopes that the cell
 * migration would immediately invalidate.
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

/**
 * The cells that may hold a socket owned by these users: each owner's own
 * cell, plus the single cell that clients predating owner routing still use.
 */
export function relayRuntimeCellsForOwners<Id, Stub>(
  env: RelayRuntimeCellEnv<Id, Stub>,
  ownerUserIds: Iterable<string>,
): Stub[] {
  const names = new Set<string>([RELAY_RUNTIME_SINGLE_CELL_NAME]);
  for (const ownerUserId of ownerUserIds) {
    const name = relayRuntimeOwnerCellName(ownerUserId);
    if (name) names.add(name);
  }
  return Array.from(names, (name) => runtimeCell(env, name));
}

/**
 * Resolves the bounded route-directory shard for a typed product scope. An
 * invalid scope never reaches `idFromName`, so it cannot mint a caller-chosen
 * Durable Object name.
 */
export function relayRuntimeRouteDirectory<Id, Stub>(
  namespace: DurableNamespaceLike<Id, Stub>,
  scopeId: string,
): Stub | undefined {
  const shardName = runtimeRouteDirectoryShardName(scopeId);
  return shardName ? namespace.get(namespace.idFromName(shardName)) : undefined;
}

/**
 * One fanout object per channel. The scope id is checked before it becomes an
 * object name, and the location hint is part of that name so a move creates a
 * new object beside the database instead of reusing one pinned elsewhere.
 */
export function relayRuntimeChannelFanout<Id, Stub>(
  namespace: DurableNamespaceLike<Id, Stub>,
  scopeId: string,
  env: { XMATRIX_RUNTIME_LOCATION_HINT?: string },
): Stub | undefined {
  if (!isRuntimeRouteDirectoryScopeId(scopeId)) return undefined;
  const locationHint = relayRuntimeLocationHint(env.XMATRIX_RUNTIME_LOCATION_HINT);
  const name = locationHint ? `fanout:${scopeId}@${locationHint}` : `fanout:${scopeId}`;
  const id = namespace.idFromName(name);
  return locationHint ? namespace.get(id, { locationHint }) : namespace.get(id);
}

/**
 * Resolves a Runtime cell by name for the dual-accept phase. The name MUST
 * come from the runtime cell locator's closed set (ticket or claim parsers),
 * never from raw request data — the parsers enumerate every legal cell.
 */
export function relayRuntimeCellNamed<Id, Stub>(
  env: RelayRuntimeCellEnv<Id, Stub>,
  cellName: string,
): Stub {
  return runtimeCell(env, cellName);
}
