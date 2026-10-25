/**
 * Runtime cell names: each user's own cell, and the single cell `cell-0`,
 * which holds no product socket and runs work that must sit beside
 * PostgreSQL (harness-release-watch.ts).
 */
export const RELAY_RUNTIME_SELECTED_CELL = "cell-0" as const;

export type RelayRuntimeOwnerCell = `user-${string}`;

/** Header the Worker sets on a socket it routed to an owner cell. */
export const RELAY_RUNTIME_CELL_HEADER = "x-xmatrix-runtime-cell";

const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/**
 * Each user's sockets (browser tabs, daemons, Agent Instances) live in that
 * user's own Runtime cell, so capacity grows with users instead of queueing
 * everyone behind one object, and a delivery for a person is a delivery to
 * their cell. Returns undefined for anything that is not a plain user id, so
 * request data can never mint an arbitrary object name.
 */
export function relayRuntimeOwnerCellName(ownerUserId: string): RelayRuntimeOwnerCell | undefined {
  return OWNER_ID.test(ownerUserId) ? `user-${ownerUserId}` : undefined;
}

export function isRelayRuntimeOwnerCell(value: unknown): value is RelayRuntimeOwnerCell {
  return typeof value === "string" && value.startsWith("user-") &&
    relayRuntimeOwnerCellName(value.slice("user-".length)) === value;
}
