import { utf8ByteLength } from "@xmatrix/protocol";
/**
 * Fixed, versioned placement for Runtime route-directory Durable Objects.
 *
 * A scope maps to exactly one of these directory shards. This is directory
 * placement only: the mapping is a replaceable Runtime projection and never
 * decides which scopes a principal may read or write.
 */
import {
  isRelayRuntimeOwnerCell,
  isRelayRuntimeShadowCandidate,
  RELAY_RUNTIME_SELECTED_CELL,
  type RelayRuntimeOwnerCell,
} from "./runtime-cell-locator";

export const RUNTIME_ROUTE_DIRECTORY_GENERATION = "runtime-route-directory-v1" as const;
export const RUNTIME_ROUTE_DIRECTORY_SHARD_COUNT = 16 as const;
/** One minute beyond the Relay V2 session deadline for best-effort unregister. */
export const RUNTIME_ROUTE_DIRECTORY_ENTRY_TTL_MS = 16 * 60_000;
export const RUNTIME_ROUTE_DIRECTORY_MAX_SCOPE_IDS_PER_REQUEST = 100 as const;

/**
 * An owner cell holds long-lived hibernating product sockets that may sit idle
 * far longer than a session ticket. It registers on subscribe and unregisters
 * when the last subscriber leaves; a delivery that finds no subscriber removes
 * a leftover route at once, so this only bounds a cell that vanished silently.
 */
export const RUNTIME_ROUTE_DIRECTORY_OWNER_CELL_TTL_MS = 7 * 24 * 60 * 60_000;

/** How long one registration of this cell stays routable. */
export function runtimeRouteDirectoryEntryTtlMs(cellName: RuntimeRouteDirectoryCell): number {
  return isRelayRuntimeOwnerCell(cellName)
    ? RUNTIME_ROUTE_DIRECTORY_OWNER_CELL_TTL_MS
    : RUNTIME_ROUTE_DIRECTORY_ENTRY_TTL_MS;
}

const MAX_SCOPE_ID_BYTES = 200;

export type RuntimeRouteDirectoryCell =
  | typeof RELAY_RUNTIME_SELECTED_CELL
  | `cell-v1-${string}`
  | RelayRuntimeOwnerCell;

/** A directory response may only select a cell the Runtime locators can name. */
export function isRuntimeRouteDirectoryCell(value: unknown): value is RuntimeRouteDirectoryCell {
  return value === RELAY_RUNTIME_SELECTED_CELL || isRelayRuntimeShadowCandidate(value) ||
    isRelayRuntimeOwnerCell(value);
}

/**
 * Scope ids originate in typed product state, not request-controlled cell
 * names. Keep their byte size bounded before they can select a directory DO.
 */
export function isRuntimeRouteDirectoryScopeId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) return false;
  return utf8ByteLength(value) <= MAX_SCOPE_ID_BYTES;
}

/** Stable FNV-1a over UTF-8. A generation change is required to alter it. */
export function runtimeRouteDirectoryShardName(scopeId: string): string | undefined {
  if (!isRuntimeRouteDirectoryScopeId(scopeId)) return undefined;
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(scopeId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const shard = hash % RUNTIME_ROUTE_DIRECTORY_SHARD_COUNT;
  return `${RUNTIME_ROUTE_DIRECTORY_GENERATION}-${shard.toString(10).padStart(2, "0")}`;
}
