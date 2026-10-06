/**
 * Runtime cell names: the single cell `cell-0`, each user's own cell, and the
 * bounded `cell-v1-NN` candidates the route directory still accepts.
 */
export const RELAY_RUNTIME_SELECTED_CELL = "cell-0" as const;
export const RELAY_RUNTIME_SHADOW_CELL_COUNT = 16 as const;

export type RelayRuntimeOwnerCell = `user-${string}`;

/** Header the Worker sets on a socket it routed to an owner cell. */
export const RELAY_RUNTIME_CELL_HEADER = "x-xmatrix-runtime-cell";

const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * Each user's sockets (browser tabs, daemons, Agent Instances) live in that
 * user's own Runtime cell, so capacity grows with users instead of queueing
 * everyone behind one object. Returns undefined for anything that is not a
 * plain user id, so request data can never mint an arbitrary object name.
 */
export function relayRuntimeOwnerCellName(ownerUserId: string): RelayRuntimeOwnerCell | undefined {
  return OWNER_ID.test(ownerUserId) ? `user-${ownerUserId}` : undefined;
}

export function isRelayRuntimeOwnerCell(value: unknown): value is RelayRuntimeOwnerCell {
  return typeof value === "string" && value.startsWith("user-") &&
    relayRuntimeOwnerCellName(value.slice("user-".length)) === value;
}

export type RelayRuntimeRoutingMode = "shadow" | "dual";

/**
 * Deployment switch for the dual-accept phase. Anything but the exact string
 * "dual" stays shadow, so an unset or mistyped variable cannot activate
 * candidate cells.
 */
export function relayRuntimeRoutingMode(value: unknown): RelayRuntimeRoutingMode {
  return value === "dual" ? "dual" : "shadow";
}

function candidateCell(bucket: number): `cell-v1-${string}` {
  return `cell-v1-${bucket.toString(10).padStart(2, "0")}`;
}

export function isRelayRuntimeShadowCandidate(value: unknown): value is `cell-v1-${string}` {
  if (typeof value !== "string") return false;
  for (let bucket = 0; bucket < RELAY_RUNTIME_SHADOW_CELL_COUNT; bucket += 1) {
    if (value === candidateCell(bucket)) return true;
  }
  return false;
}
