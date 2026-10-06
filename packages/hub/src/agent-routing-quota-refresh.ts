import type { RoutingQuotaProbeRequest } from "@xmatrix/protocol";
import { PostgresMachineControlRepository, PostgresSpacePlacementDirectory,
  readRegistrationQuotaProbeTargets, type AuthorityDatabase, type PostgresRuntimeRepository,
  type RegistrationQuotaProbeTarget } from "@xmatrix/db";
import { machineDaemonCommand } from "./machines";
import type { Env } from "./types";

/** Only an authorized Channel snapshot supplies targets: the Space's
 * authorized registrations. Neither the caller nor a daemon can name a quota
 * pool or owner to write. This only asks each daemon to read its quota; the
 * daemon's completed probe records the readings (see
 * `recordRegistrationQuotaProbeResult`), however long the provider takes, so
 * nothing here waits for them. Selection reads those persisted facts. */
export async function refreshAgentRoutingQuota(input: {
  env: Env; directory: AuthorityDatabase; runtime: PostgresRuntimeRepository;
  channelId: string; actorUserId: string;
  registrationTargets: (spaceId: string) => Promise<RegistrationQuotaProbeTarget[]>;
}, dependencies: QuotaProbeIssueDependencies = {}): Promise<{ issued: number }> {
  const { spaceId } = await input.runtime.launchChannelSpace({ requestId: crypto.randomUUID(),
    channelId: input.channelId, actorUserId: input.actorUserId });
  return issueRegistrationQuotaProbes({ env: input.env, directory: input.directory,
    entries: await input.registrationTargets(spaceId) }, dependencies);
}

export type QuotaProbeIssueDependencies = { issue?: (command: Record<string, unknown>) => Promise<unknown>;
  machines?: Pick<PostgresMachineControlRepository, "getDaemon"> };

/** Ask each target's daemon to read its quota, one probe per daemon and at
 * most 32 targets each. Targets come only from the server's registration read. */
export async function issueRegistrationQuotaProbes(input: {
  env: Env; directory: AuthorityDatabase; entries: readonly RegistrationQuotaProbeTarget[];
}, dependencies: QuotaProbeIssueDependencies = {}): Promise<{ issued: number }> {
  const { entries } = input;
  const groups = new Map<string, RegistrationQuotaProbeTarget[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.ownerUserId, entry.machineId, entry.hostId, entry.connectionEpoch]);
    const group = groups.get(key) ?? [];
    // A daemon answers each target id once per probe.
    if (!group.some(item => item.targetId === entry.targetId)) group.push(entry);
    groups.set(key, group);
  }
  const batches = [...groups.values()].flatMap(group => {
    const result: RegistrationQuotaProbeTarget[][] = [];
    for (let offset = 0; offset < group.length; offset += 32) result.push(group.slice(offset, offset + 32));
    return result;
  });
  const machines = dependencies.machines ?? new PostgresMachineControlRepository(input.directory);
  let next = 0, issued = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++]!;
      const first = batch[0]!;
      const requestId = `quota:${crypto.randomUUID()}`;
      const probe: RoutingQuotaProbeRequest = { requestId, connectionEpoch: first.connectionEpoch,
        targets: batch.map(entry => ({ targetId: entry.targetId, configurationDigest: entry.configurationDigest })),
        windowLabels: true, quotaAccount: true };
      const route = { ownerUserId: first.ownerUserId, machineId: first.machineId, hostId: first.hostId };
      try {
        const { daemon } = await machines.getDaemon({ requestId, ...route });
        if (!daemon || daemon.status !== "online" || !daemon.capabilities.includes("machine_quota_probe_v2")) continue;
        await (dependencies.issue ?? (command => machineDaemonCommand(input.env, command)))({
          ...route, ownerEmail: daemon.email, daemonId: daemon.id,
          commandId: `issue:${requestId}`, action: "issue", controlId: requestId, commandType: "quota_probe",
          principal: { kind: "user", id: route.ownerUserId },
          payload: { type: "machine_quota_probe", requestId, probe },
        });
        issued++;
      } catch (error) {
        // An unissued probe leaves the previous authoritative quota facts in place.
        console.warn("Routing quota refresh failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker));
  return { issued };
}

/** Registration targets of a Space at its active placement; an inactive or
 * moved placement probes nothing rather than guessing. */
export function registrationQuotaProbeTargetReader(database: AuthorityDatabase, directory: AuthorityDatabase) {
  return async (spaceId: string): Promise<RegistrationQuotaProbeTarget[]> => {
    const requestId = `quota-registrations:${crypto.randomUUID()}`;
    const placement = await new PostgresSpacePlacementDirectory(directory).resolve(
      { requestId, operation: "registration.quota-probe.placement" }, spaceId);
    if (placement.state !== "active" || placement.spaceId !== spaceId) return [];
    return readRegistrationQuotaProbeTargets({ database, directory, requestId, placement: {
      spaceId: placement.spaceId, shardId: placement.shardId, placementEpoch: placement.placementEpoch } });
  };
}

/** Start a quota probe without delaying the decision that reads persisted quota.
 * `scheduleBackground` retains the probe after the response; Workers drop an
 * untracked promise, and the next selection would keep the previous snapshot. */
export function scheduleAgentRoutingQuotaRefresh(
  start: () => Promise<unknown>,
  scheduleBackground?: (task: Promise<unknown>) => void,
): void {
  const task = new Promise<unknown>(resolve => { resolve(start()); }).catch((error: unknown) => {
    console.error("agent routing quota refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (!scheduleBackground) return;
  try { scheduleBackground(task); }
  catch (error) {
    console.error("agent routing quota refresh was not retained", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
