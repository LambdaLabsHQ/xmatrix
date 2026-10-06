/**
 * Machine/daemon identity and live-presence helpers.
 *
 * hostId/hostName are human-readable labels. Distinct execution environments on
 * one physical host (native Windows vs WSL) may share them, so machineId is the
 * only merge key. Missing identity never enables a label-based match.
 *
 * Live presence is the Core projection of a deliverable session: `online` after
 * connect or successful claim+send, `offline` after disconnect / failed deliver.
 * lastSeen is display-only and never a second liveness clock.
 */

const LIVE_DAEMON_STATUS = "online";

export type MachineDaemonPresence = {
  status?: string;
  lastSeenAt?: string;
  connectedAt?: string;
  machineId?: string;
  hostId?: string;
  hostName?: string;
  name?: string;
};

export function machineIdentityKeys({
  machineId,
}: {
  machineId?: string;
}): string[] {
  const id = machineId?.trim();
  return id ? [id] : [];
}

export function normalizedMachineKeys(keys: string[]): string[] {
  return Array.from(new Set(keys.map((key) => key.trim()).filter(Boolean)));
}

export function isLiveMachineDaemon(daemon: MachineDaemonPresence): boolean {
  return (daemon.status?.trim().toLowerCase() || "") === LIVE_DAEMON_STATUS;
}

export function preferredMachineDaemon<T extends MachineDaemonPresence>(
  current: T | undefined,
  next: T,
): T {
  if (!current) return next;
  const currentLive = isLiveMachineDaemon(current);
  const nextLive = isLiveMachineDaemon(next);
  if (currentLive !== nextLive) return nextLive ? next : current;
  const currentSeen = Date.parse(current.lastSeenAt || current.connectedAt || "") || 0;
  const nextSeen = Date.parse(next.lastSeenAt || next.connectedAt || "") || 0;
  return nextSeen >= currentSeen ? next : current;
}

export function daemonPresenceLabel(daemon: MachineDaemonPresence | undefined): string {
  if (!daemon) return "offline";
  if (isLiveMachineDaemon(daemon)) return "online";
  const status = daemon.status?.trim().toLowerCase() || "";
  if (status === "enrolled") return "enrolled";
  return status || "offline";
}
