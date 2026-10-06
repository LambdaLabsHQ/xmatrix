/**
 * Single Machine Daemon liveness facts.
 *
 * `reachable` means the sole session accepted the claim. An empty pending
 * queue is still a successful wake; it is not a failed delivery.
 * `deliverable` means at least one command was written onto that session.
 * Catalog status, lastSeen, and HTTP polls are not these facts.
 */
export function machineDaemonReachable(result: {
  owners?: number;
}): boolean {
  return (result.owners ?? 0) > 0;
}

export function machineDaemonDeliverable(result: {
  delivered?: number;
}): boolean {
  return (result.delivered ?? 0) > 0;
}
