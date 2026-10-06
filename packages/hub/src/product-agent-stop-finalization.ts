import { isActiveRunStatus, isTerminalRunStatus } from "@xmatrix/protocol";
interface StopSnapshot {
  id?: unknown;
  runId?: unknown;
  status?: unknown;
  version?: unknown;
}

export interface ConfirmedStopFinalizationPort {
  readRun(): Promise<StopSnapshot>;
  /** `null` when no Instance was ever recorded for the target, as when its
   * launch failed before one existed. */
  readInstance(): Promise<StopSnapshot | null>;
  transitionRun(expectedVersion?: number): Promise<"applied" | "conflict">;
  transitionInstance(expectedVersion?: number, expectedRunId?: string): Promise<"applied" | "conflict">;
}

function version(snapshot: StopSnapshot, required: boolean): number | undefined {
  const value = Number(snapshot.version);
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (required) throw new Error("Confirmed stop cannot be finalized without a current lifecycle version");
  return undefined;
}

/** Called only after the exact daemon command/result proves termination. Run
 * and Instance versions come from fresh reads, not the earlier target list.
 * A stable Instance may already belong to a reborn successor by this point. */
export async function finalizeConfirmedAgentStop(input: {
  runId: string; instanceId: string; versionedAuthority: boolean; port: ConfirmedStopFinalizationPort;
}): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const run = await input.port.readRun();
    if ((run.id ?? run.runId) !== input.runId) throw new Error("Confirmed stop Run identity changed");
    if (isActiveRunStatus(run.status)) {
      if (await input.port.transitionRun(version(run, input.versionedAuthority)) === "conflict") continue;
    } else if (!isTerminalRunStatus(run.status)) {
      throw new Error("Confirmed stop Run state is unavailable");
    }
    const instance = await input.port.readInstance();
    // The Run is terminal and never had an Instance: nothing is left to close.
    if (instance === null) return;
    if (instance.id !== input.instanceId || typeof instance.runId !== "string") {
      throw new Error("Confirmed stop Instance identity is unavailable");
    }
    // Terminating the predecessor must never mutate its reborn successor.
    if (instance.runId !== input.runId || instance.status === "offline") return;
    if (await input.port.transitionInstance(version(instance, input.versionedAuthority),
      input.versionedAuthority ? input.runId : undefined) === "applied") return;
  }
  throw new Error("The process stopped, but lifecycle state changed during confirmation; retry finalization");
}
