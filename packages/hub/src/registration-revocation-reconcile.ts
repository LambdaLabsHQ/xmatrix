import { PostgresRegistrationRevocationRepository, PostgresRegistrationExecutionRepository, PostgresRuntimeRepository,
  PostgresAgentEnvironmentRepository,
  type RegistrationStopIntent, type AuthorityDatabase } from "@xmatrix/db";
import { finalizeConfirmedAgentStop } from "./product-agent-stop-finalization";
import type { HubAuthorityEnv } from "./postgres-authority-fleet";
import { machineCommandStatus, machineDaemonCommand, machineRepository } from "./machines";

export interface RegistrationStopPort {
  release(intent: RegistrationStopIntent): Promise<{ state: string }>;
  issue(intent: RegistrationStopIntent): Promise<unknown>;
  status(intent: RegistrationStopIntent): Promise<Record<string, unknown>>;
  finalize(intent: RegistrationStopIntent): Promise<void>;
}

/** One pass stays inside the coordinator's 20-second step deadline. */
const REGISTRATION_STOP_PASS_MS = 15_000;

/** A deferral keeps why it failed: an error's own code, or a code-shaped
 * message this module throws, else only the error's class name — never free
 * text, which may carry request detail. */
function deferralCode(error: unknown): string {
  const raw = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
    : error instanceof Error ? error.message : "";
  const code = /^[A-Za-z0-9_.:-]{1,60}$/u.test(raw) ? raw : error instanceof Error ? error.name : "unknown";
  return `registration_stop_deferred:${code}`.slice(0, 100);
}

/** Lease expiration permits a retry, never a declaration that a host stopped.
 * The exact command may be renewed after failure without changing the Run.
 *
 * Claimed stops run one at a time. Each one opens several PostgreSQL
 * transactions and product calls; run in parallel inside one Worker
 * invocation, they held BEGUN transactions idle while their next statement
 * queued behind the others, which pinned the shared connection pool. A stop
 * the pass has no time left for is settled untouched, releasing its lease. */
export async function reconcileRegistrationStops(repository: Pick<PostgresRegistrationRevocationRepository, "prepare" | "claim" | "settle" | "completeChanges">,
  port: RegistrationStopPort, channelId: string,
  options: { passMs?: number; includeParked?: boolean } = {}): Promise<number> {
  // Keep existing durable obligations moving even if discovery fails. Surface
  // the failure after this batch so maintenance does not report false success.
  let preparationFailure: unknown;
  try { await repository.prepare(channelId); } catch (error) { preparationFailure = error; }
  const rows = await repository.claim(channelId, options.includeParked === true);
  const passDeadline = Date.now()+(options.passMs ?? REGISTRATION_STOP_PASS_MS);
  // A timer may fire a millisecond before the clock reads its deadline; once
  // the pass's own timer has fired, no later stop starts in this pass.
  let passSpent = false;
  let settlementFailure: unknown;
  for (const intent of rows) {
    let completed = false, replaceCommand = false, parked = false, errorCode: string | undefined;
    const deadline = Math.min(Date.now()+20_000, passDeadline);
    const step = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = deadline-Date.now();
      if (passSpent || remaining <= 0) throw new Error("registration_stop_timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (deadline === passDeadline) passSpent = true;
          reject(new Error("registration_stop_timeout"));
        }, remaining);
      })]); } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    try {
      let resource = await step(() => port.release(intent));
      if (resource.state !== "released") {
        const readStatus = async () => await step(() => port.status(intent)) as {
          status?: string; result?: { ok?: boolean; runId?: string; instanceId?: string } };
        let status = await readStatus();
        if (status.status === "missing") {
          await step(() => port.issue(intent));
          status = await readStatus();
        }
        if (["missing","failed","expired"].includes(status.status ?? "")) {
          replaceCommand = true; errorCode = "registration_stop_command_retry"; continue;
        }
        // Delivered, waiting on its host: nothing changes until the host acts,
        // and that report wakes this Channel.
        if (status.status !== "completed") { parked = true; continue; }
        if (status.result?.ok !== true || status.result.runId !== intent.runId || status.result.instanceId !== intent.instanceId) {
          errorCode = "registration_stop_evidence_mismatch"; continue;
        }
        resource = await step(() => port.release(intent));
        if (resource.state !== "released") continue;
      }
      // Released means either the resource was never admitted or the global
      // authority has authenticated exact process-terminal evidence.
      await step(() => port.finalize(intent));
      completed = true;
    } catch (error) {
      errorCode = deferralCode(error);
    } finally {
      try { await repository.settle({ intent, completed, replaceCommand, parked, errorCode }); }
      catch (error) { settlementFailure ??= error; }
    }
  }
  if (settlementFailure) throw settlementFailure;
  if (preparationFailure) throw preparationFailure;
  await repository.completeChanges(channelId);
  return rows.length;
}

export async function reconcileRegistrationRevocations(database: AuthorityDatabase, directory: AuthorityDatabase,
  shardId: string, env: HubAuthorityEnv, channelId: string, woken = false): Promise<number> {
  const runtime = new PostgresRuntimeRepository(database, shardId);
  const capacity = new PostgresRegistrationExecutionRepository(directory);
  const machines = machineRepository(env);
  const transition = async (intent: RegistrationStopIntent, input: Record<string, unknown>): Promise<"applied" | "conflict"> => {
    try {
      await runtime.mutate({ ...input, commandId: `registration-stop-finalize:${crypto.randomUUID()}`,
        actorUserId: intent.key.ownerUserId, at: new Date().toISOString() });
      return "applied";
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "conflict") return "conflict";
      throw error;
    }
  };
  const revocation = new PostgresRegistrationRevocationRepository(database);
  const environments = new PostgresAgentEnvironmentRepository(directory);
  // Machine environments live in the directory: read them first, never inside
  // the shard's revocation transaction.
  const repository = {
    prepare: async (id: string) => revocation.prepare(id, await environments.disabled({
      requestId: `registration-environment-disabled:${crypto.randomUUID()}`, keys: await revocation.activeRegistrations(id) })),
    claim: revocation.claim.bind(revocation), settle: revocation.settle.bind(revocation),
    completeChanges: revocation.completeChanges.bind(revocation),
  };
  return reconcileRegistrationStops(repository, {
    release: intent => capacity.cancel({ requestId: intent.controlId, key: intent.key,
      runId: intent.runId, allocationId: intent.allocationId, reason: "cancelled_before_start" }),
    issue: intent => machineDaemonCommand(env, {
      commandId: intent.controlId, action: "issue", controlId: intent.controlId, commandType: "stop",
      ownerUserId: intent.key.ownerUserId, ownerEmail: `${intent.key.ownerUserId.replace(/[^a-zA-Z0-9._-]/gu,"_")}@unknown.invalid`,
      machineId: intent.key.machineId, hostId: intent.hostId, metadata: {}, capabilities: [],
      payload: { type: "machine_stop_agent", requestId: intent.controlId, runId: intent.runId, instanceId: intent.instanceId,
        channelId: intent.channelId, executionKey: intent.executionKey, worktreeDisposition: "retain", reason: "Registration access withdrawn" },
      principal: { kind: "user", id: intent.key.ownerUserId },
    }),
    status: intent => machineCommandStatus(machines, "stop", {
      controlId: intent.controlId, runId: intent.runId, instanceId: intent.instanceId, executionKey: intent.executionKey,
      ownerUserId: intent.key.ownerUserId, machineId: intent.key.machineId, hostId: intent.hostId, worktreeDisposition: "retain",
    }),
    finalize: intent => finalizeConfirmedAgentStop({ runId: intent.runId, instanceId: intent.instanceId,
      versionedAuthority: true, port: {
        readRun: async () => (await runtime.getRun({ requestId: intent.controlId, runId: intent.runId, actorUserId: intent.key.ownerUserId })).run,
        readInstance: async () => {
          try {
            return (await runtime.getInstance({ requestId: intent.controlId, instanceId: intent.instanceId,
              actorUserId: intent.key.ownerUserId })).instance;
          } catch (error) {
            // A launch that failed before its Instance existed leaves only the
            // Run; retrying the read cannot make one appear.
            if (error && typeof error === "object" && "code" in error && error.code === "not_found") return null;
            throw error;
          }
        },
        transitionRun: expectedVersion => transition(intent, { kind: "run_transition", runId: intent.runId, status: "stopped", expectedVersion }),
        transitionInstance: (expectedVersion, expectedRunId) => transition(intent, { kind: "instance_transition", instanceId: intent.instanceId,
          status: "offline", terminal: true, expectedVersion, expectedRunId }),
      } }),
  }, channelId, { includeParked: woken });
}
