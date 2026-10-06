import { PostgresRegistrationExecutionRepository, RegistrationAccessError, type AuthorityDatabase } from "@xmatrix/db";
import { parseSpaceAgentRegistrationKey, parseRegistrationLaunchBinding, parseRegistrationResourceLimits, repoSummonReference, sameAgentRegistration } from "@xmatrix/protocol";
import type { MachineDaemonPrincipal } from "./connections/machine-daemon/auth";
import { createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import type { Env } from "./types";

export interface ConfirmedMachineLease {
  daemonId?: string;
  connectionEpoch: number;
}

/** admission is returned by the owning Space's execution-authorized Run read.
 * confirmedLease comes from successful machine-control renewal, not HTTP JSON.
 * This resource decision never substitutes for the Space's permission check. */
export async function authorizeRegistrationExecution(input: {
  env: Env; principal: MachineDaemonPrincipal; runId: string; spaceId: string;
  phase: "admission" | "continuation"; admission: unknown; confirmedLease?: ConfirmedMachineLease;
  claimedBinding?: unknown; instanceId?: string; workspaceCwd?: string;
  /** From the execution-authorized Run, never the daemon's request. */
  workspaceRepository?: string;
}, dependencies: { directoryDatabase?: AuthorityDatabase } = {}): Promise<Response | undefined> {
  try {
    // Every Run executes under a registration; a Run without one never runs.
    if (input.admission === undefined) throw new RegistrationAccessError("registration_run_admission_missing", 403);
    const value = input.admission as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !["key", "allocationId", "authorizationDigest", "resources"].includes(key)) ||
        typeof value.allocationId !== "string" || !value.allocationId || value.allocationId.length > 300 ||
        typeof value.authorizationDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.authorizationDigest)) {
      throw new RegistrationAccessError("registration_admission_invalid", 409);
    }
    let key;
    try { key = parseSpaceAgentRegistrationKey(value.key); }
    catch { throw new RegistrationAccessError("registration_admission_invalid", 409); }
    if (key.spaceId !== input.spaceId || key.ownerUserId !== input.principal.ownerUserId ||
        key.machineId !== input.principal.machineId) throw new RegistrationAccessError("registration_machine_mismatch", 403);
    const request = { requestId: `registration-execute:${crypto.randomUUID()}`, key, runId: input.runId,
      allocationId: value.allocationId, authorizationDigest: value.authorizationDigest, hostId: input.principal.hostId };
    if (input.phase === "admission" && (!input.confirmedLease?.daemonId ||
        !Number.isSafeInteger(input.confirmedLease.connectionEpoch) || input.confirmedLease.connectionEpoch < 1)) {
      throw new RegistrationAccessError("registration_startup_admission_required", 409);
    }
    let claimed;
    if (input.phase === "admission" || input.claimedBinding !== undefined) {
      try {
        claimed = parseRegistrationLaunchBinding(input.claimedBinding);
        const resources = parseRegistrationResourceLimits(value.resources);
        if (!sameAgentRegistration(claimed.key, key) || claimed.key.spaceId !== key.spaceId ||
            claimed.runId !== input.runId || claimed.instanceId !== input.instanceId ||
            claimed.allocationId !== value.allocationId || claimed.authorizationDigest !== value.authorizationDigest ||
            JSON.stringify(claimed.resources) !== JSON.stringify(resources)) throw new Error("Mismatched launch binding");
      } catch { throw new RegistrationAccessError("registration_launch_binding_mismatch", 403); }
    }
    if (input.phase === "admission" && (typeof input.workspaceCwd !== "string" || !input.workspaceCwd ||
      input.workspaceCwd.length > 4_000 || input.workspaceCwd.includes("\u0000"))) {
      throw new RegistrationAccessError("registration_workspace_binding_missing", 403);
    }
    const workspaceReference = claimed?.resources.workspaces[0];
    const repository = workspaceReference?.startsWith("repo:") ? workspaceReference.slice(5) : undefined;
    if (input.phase === "admission" && repository !== undefined &&
        (!repository || repoSummonReference(repository) !== repository || input.workspaceRepository !== repository)) {
      throw new RegistrationAccessError("registration_repository_binding_mismatch", 403);
    }
    // The directory session is independent of the completed Space read. Never
    // nest a transaction on the same serialized request-scoped PG session.
    const database = dependencies.directoryDatabase ?? createPostgresAuthorityFleet(input.env, {
      applicationName: "xmatrix-registration-admission", statementTimeoutMs: 5_000,
      transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
    }).directoryDatabase;
    const capacity = new PostgresRegistrationExecutionRepository(database);
    if (input.phase === "admission") await capacity.admit({ ...request,
      daemonId: input.confirmedLease!.daemonId!, connectionEpoch: input.confirmedLease!.connectionEpoch,
      expectedEnvironmentVersion: claimed!.environmentVersion, expectedRuntimeModel: claimed!.runtimeModel ?? null,
      // A repository is a Run-bound managed checkout, not a data.workspaces row.
      // Its exact admitted reference was checked against the owning Run above.
      ...(workspaceReference !== undefined && repository === undefined
        ? { expectedWorkspace: { reference: workspaceReference, canonicalCwd: input.workspaceCwd! } } : {}) });
    else await capacity.requireContinuation(request);
    return undefined;
  } catch (error) {
    if (error instanceof RegistrationAccessError) return Response.json({ code: error.code,
      error: `The registered execution location no longer authorizes this Run (${error.code})`, retryable: error.status >= 500 },
    { status: error.status, headers: { "cache-control": "private, no-store" } });
    throw error;
  }
}
