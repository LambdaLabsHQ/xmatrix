/**
 * Outbound Machine Daemon reverse-wake after a durable PostgreSQL issue commit.
 *
 * The wake reports deliverability: claim+send on the sole session, or no owner.
 * Recovery is reconnect + catch-up, not a second clock.
 */
import { RELAY_RUNTIME_MACHINE_DAEMON_CLAIM_PATH } from "./runtime-transport/relay-runtime-product-adapter";
import { machineDaemonDeliverable } from "./runtime-transport/machine-daemon-deliverable";

export interface MachineDaemonWakeResult {
  matched: number;
  delivered: number;
  owners: number;
  healed: boolean;
  deliverable: boolean;
}

export function emptyMachineDaemonWakeResult(): MachineDaemonWakeResult {
  return {
    matched: 0,
    delivered: 0,
    owners: 0,
    healed: false,
    deliverable: false,
  };
}

/** Consumer-facing outbound wake API. */
export interface MachineDaemonWake {
  wake(ownerUserId: string, machineId: string, hostId: string): Promise<MachineDaemonWakeResult>;
}

export interface MachineDaemonWakeFetcher {
  fetch(request: Request): Promise<Response>;
}

function committedIssueRoute(
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): [ownerUserId: string, machineId: string, hostId: string] | undefined {
  if (input.action !== "issue" && input.action !== "issue_batch") return undefined;
  const daemon = result.daemon && typeof result.daemon === "object" &&
      !Array.isArray(result.daemon)
    ? result.daemon as Record<string, unknown>
    : undefined;
  const ownerUserId = stringRoutePart(daemon?.userId) || stringRoutePart(input.ownerUserId);
  const machineId = stringRoutePart(daemon?.machineId) || stringRoutePart(input.machineId);
  const hostId = stringRoutePart(daemon?.hostId) || stringRoutePart(input.hostId);
  if (ownerUserId && machineId) return [ownerUserId, machineId, hostId];
  console.error("Machine Daemon issue committed without a wake route", {
    commandId: input.commandId,
    controlId: input.controlId,
  });
  return undefined;
}

/**
 * Invoke the targeted wake only after the canonical control method returned,
 * which proves the issue transaction committed. The serialized daemon is the
 * authoritative route; input fallback keeps legacy authority mode compatible.
 */
function committedWakeRoute(
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): [ownerUserId: string, machineId: string, hostId: string] | undefined {
  if (input.skipWake === true) return undefined;
  return committedIssueRoute(input, result);
}

async function wakeCommittedIssueUsing(input: Record<string, unknown>, result: Record<string, unknown>,
  wake: MachineDaemonWake["wake"]): Promise<MachineDaemonWakeResult | undefined> {
  const route = committedWakeRoute(input, result);
  return route ? wake(...route) : undefined;
}

function stringRoutePart(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function wakeResultFromUnknown(value: unknown): MachineDaemonWakeResult {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const delivered = Number(record.delivered);
  const owners = Number(record.owners);
  const matched = Number(record.matched);
  const result = {
    matched: Number.isFinite(matched) && matched > 0 ? matched : 0,
    delivered: Number.isFinite(delivered) && delivered > 0 ? delivered : 0,
    owners: Number.isFinite(owners) && owners > 0 ? owners : 0,
    healed: record.healed === true,
  };
  return {
    ...result,
    deliverable: machineDaemonDeliverable(result),
  };
}

function failedMachineDaemonWake(error: unknown, ownerUserId: string,
  machineId: string, hostId: string): MachineDaemonWakeResult {
  console.warn("Machine Daemon issue wake failed", {
    ownerUserId, machineId, hostId, error: error instanceof Error ? error.message : String(error),
  });
  return emptyMachineDaemonWakeResult();
}

async function requestMachineDaemonWake(
  fetcher: MachineDaemonWakeFetcher,
  ownerUserId: string,
  machineId: string,
  hostId: string,
): Promise<MachineDaemonWakeResult> {
  try {
    const response = await fetcher.fetch(new Request(
      `https://relay-runtime${RELAY_RUNTIME_MACHINE_DAEMON_CLAIM_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerUserId, machineId, hostId }),
      },
    ));
    if (!response.ok) {
      console.warn("Machine Daemon issue wake was unavailable", {
        ownerUserId, machineId, hostId, status: response.status,
      });
      return emptyMachineDaemonWakeResult();
    }
    const payload = await response.json().catch(() => ({}));
    return wakeResultFromUnknown(payload);
  } catch (error) {
    return failedMachineDaemonWake(error, ownerUserId, machineId, hostId);
  }
}

/**
 * Await one bounded Runtime wake after the durable commit; a failed wake is
 * reported as not deliverable, never as a failed issue.
 */
export async function wakeCommittedPostgresMachineDaemonIssue(
  fetcherFor: (ownerUserId: string) => MachineDaemonWakeFetcher,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<MachineDaemonWakeResult | undefined> {
  return wakeCommittedIssueUsing(input, result,
    (owner, machine, host) => requestMachineDaemonWake(fetcherFor(owner), owner, machine, host));
}

/**
 * One wake across every Runtime cell that may hold the daemon's socket (its
 * owner's cell, and the single cell older daemons still connect to). The
 * daemon is live in at most one of them, so the counts simply add up.
 */
export function machineDaemonWakeFanOut(
  fetchers: readonly MachineDaemonWakeFetcher[],
): MachineDaemonWakeFetcher {
  return {
    async fetch(request: Request): Promise<Response> {
      const body = await request.text();
      const answers = await Promise.all(fetchers.map(async (fetcher) => {
        try {
          const response = await fetcher.fetch(new Request(request.url, {
            method: request.method, headers: request.headers, body,
          }));
          return response.ok ? wakeResultFromUnknown(await response.json().catch(() => ({}))) : undefined;
        } catch {
          return undefined;
        }
      }));
      const answered = answers.filter((answer) => answer !== undefined);
      if (answered.length === 0) return Response.json({ error: "Runtime wake unavailable" }, { status: 503 });
      return Response.json({
        matched: answered.reduce((sum, answer) => sum + answer.matched, 0),
        delivered: answered.reduce((sum, answer) => sum + answer.delivered, 0),
        owners: answered.reduce((sum, answer) => sum + answer.owners, 0),
        healed: answered.some((answer) => answer.healed),
      });
    },
  };
}
