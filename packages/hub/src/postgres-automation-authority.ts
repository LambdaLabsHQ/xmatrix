import { PostgresAutomationRepository, type AuthorityDatabase } from "@xmatrix/db";
import type { AutomationExecutionRow, AutomationOccurrenceRow } from "./automation-occurrence-rows";
import type { ScheduleOccurrenceLifecycle } from "./relay-authority-schedule-occurrence";
import {
  createPostgresAuthorityFleet,
  type PostgresAuthorityFleetEnv,
} from "./postgres-authority-fleet";
import { resolveAutomationRunTimeoutMs } from "./automation-lifecycle";
import { POSTGRES_AUTHORITY_TIMEOUTS, postgresAuthorityShardId } from "./postgres-authority-http";

interface AutomationEnv extends PostgresAuthorityFleetEnv {
  RELAY_AUTOMATION_RUN_TIMEOUT_MS?: string;
}

export class PostgresScheduleOccurrenceLifecycle implements ScheduleOccurrenceLifecycle {
  private readonly repositories: readonly PostgresAutomationRepository[];
  private readonly executionRepository?: PostgresAutomationRepository;
  private readonly occurrenceRepositories = new Map<string, PostgresAutomationRepository>();
  private readonly taskRepositories = new Map<string, PostgresAutomationRepository>();
  private lastRepository: PostgresAutomationRepository | null = null;
  private readonly runTimeoutMs: number;
  private readonly spaceId: string | undefined;

  constructor(env: AutomationEnv, database?: AuthorityDatabase, dependencies: {
    repositories?: readonly PostgresAutomationRepository[];
    spaceId?: string;
  } = {}) {
    postgresAuthorityShardId(env, "Automation");
    if (dependencies.repositories) {
      if (dependencies.repositories.length === 0) throw new Error(
        "PostgreSQL Automation shard fleet is empty");
      this.repositories = dependencies.repositories;
    } else if (database) {
      this.repositories = [new PostgresAutomationRepository(database)];
    } else {
      const fleet = createPostgresAuthorityFleet(env, {
        applicationName: "xmatrix-hub-scheduled-occurrence", ...POSTGRES_AUTHORITY_TIMEOUTS,
      });
      if (dependencies.spaceId) this.executionRepository = new PostgresAutomationRepository(fleet.database);
      this.repositories = fleet.physicalShards.map(({ database: physicalDatabase }) =>
        new PostgresAutomationRepository(physicalDatabase));
    }
    this.runTimeoutMs = resolveAutomationRunTimeoutMs(env.RELAY_AUTOMATION_RUN_TIMEOUT_MS);
    this.spaceId = dependencies.spaceId;
  }

  private bind(
    occurrence: AutomationOccurrenceRow,
    repository: PostgresAutomationRepository,
  ): AutomationOccurrenceRow {
    this.occurrenceRepositories.set(occurrence.id, repository);
    this.taskRepositories.set(occurrence.task_id, repository);
    this.lastRepository = repository;
    return occurrence;
  }

  private occurrenceRepository(occurrenceId: string): PostgresAutomationRepository {
    const repository = this.occurrenceRepositories.get(occurrenceId) ??
      (this.repositories.length === 1 ? this.repositories[0] : undefined);
    if (!repository) throw new Error("Scheduled occurrence shard affinity is unavailable");
    return repository;
  }

  private taskRepository(automationId: string): PostgresAutomationRepository {
    const repository = this.taskRepositories.get(automationId) ??
      (this.repositories.length === 1 ? this.repositories[0] : undefined);
    if (!repository) throw new Error("Automation shard affinity is unavailable");
    return repository;
  }

  async maintain(_nowDate: Date, now: string, spaceId = this.spaceId): Promise<void> {
    await Promise.all(this.repositories.map((repository) => repository.maintain({
      requestId: crypto.randomUUID(), now, runTimeoutMs: this.runTimeoutMs,
      ...(spaceId ? { spaceId } : {}),
    })));
  }

  async claim(_nowDate: Date, now: string, leaseOwner: string) {
    for (const repository of this.repositories) {
      const occurrence = await repository.claim({ requestId: crypto.randomUUID(), now, leaseOwner,
        ...(this.spaceId ? { spaceId: this.spaceId } : {}) }) as
        AutomationOccurrenceRow | undefined;
      if (occurrence) return this.bind(occurrence, repository);
    }
    return undefined;
  }

  async cancel(occurrence: AutomationOccurrenceRow, now: string,
    code: string, message: string): Promise<void> {
    await this.occurrenceRepository(occurrence.id).cancel({
      requestId: crypto.randomUUID(), occurrenceId: occurrence.id,
      leaseOwner: String(occurrence.lease_owner), now, code, message });
    this.occurrenceRepositories.delete(occurrence.id);
  }

  async fail(occurrence: AutomationOccurrenceRow, _nowDate: Date, now: string,
    error: unknown, permanent: boolean): Promise<void> {
    await this.occurrenceRepository(occurrence.id).fail({
      requestId: crypto.randomUUID(), occurrenceId: occurrence.id,
      taskId: occurrence.task_id, taskVersion: occurrence.task_version, attempts: occurrence.attempts,
      leaseOwner: String(occurrence.lease_owner), now,
      message: error instanceof Error ? error.message : String(error), permanent });
    this.occurrenceRepositories.delete(occurrence.id);
  }

  async getAutomation(automationId: string): Promise<AutomationExecutionRow | undefined> {
    return await this.taskRepository(automationId).getExecutionAutomation({ requestId: crypto.randomUUID(), taskId: automationId }) as
      AutomationExecutionRow | undefined;
  }

  async markPrepared(occurrence: AutomationOccurrenceRow, now: string): Promise<void> {
    await this.occurrenceRepository(occurrence.id).markPrepared({
      requestId: crypto.randomUUID(), occurrenceId: occurrence.id,
      leaseOwner: String(occurrence.lease_owner), now, deliveryKind: occurrence.delivery_kind,
      ...(occurrence.message_id ? { messageId: occurrence.message_id } : {}),
      runId: occurrence.run_id, instanceId: occurrence.instance_id });
  }

  async markDispatched(occurrence: AutomationOccurrenceRow,
    automation: AutomationExecutionRow, now: string): Promise<void> {
    await this.occurrenceRepository(occurrence.id).markDispatched({ requestId: crypto.randomUUID(),
      occurrenceId: occurrence.id, leaseOwner: String(occurrence.lease_owner), taskId: automation.id,
      runId: occurrence.run_id, executionTimeoutMs: occurrence.execution_timeout_ms, now });
  }

  async finishMessage(occurrence: AutomationOccurrenceRow,
    automation: AutomationExecutionRow, now: string): Promise<void> {
    if (!occurrence.message_id) throw new Error("Scheduled message id is unavailable");
    await this.occurrenceRepository(occurrence.id).finishMessage({
      requestId: crypto.randomUUID(), occurrenceId: occurrence.id,
      leaseOwner: String(occurrence.lease_owner), taskId: automation.id,
      messageId: occurrence.message_id, now });
    this.occurrenceRepositories.delete(occurrence.id);
  }

  async assertPrepared(input: { occurrenceId: string; taskId: string; leaseOwner: string;
    controlId: string; runId: string }): Promise<void> {
    await this.occurrenceRepository(input.occurrenceId).assertPrepared({
      requestId: crypto.randomUUID(), ...input,
    });
  }

  async requireEvaluationAuthority(channelId: string, authorityRootUserId: string): Promise<void> {
    const repository = this.lastRepository ??
      (this.repositories.length === 1 ? this.repositories[0] : undefined);
    if (!repository) throw new Error("Scheduled evaluation shard affinity is unavailable");
    await repository.requireEvaluationAuthority({ requestId: crypto.randomUUID(),
      channelId, authorityRootUserId });
  }

  async reapExpiredRuns(nowDate: Date, issueStop: (input: {
    occurrence: AutomationOccurrenceRow;
    machineId: string; hostId: string; executionKey: string; controlId: string;
  }) => Promise<void>): Promise<void> {
    const now = nowDate.toISOString();
    if (!this.spaceId) throw new Error("Execution cancellation requires a scoped Space alarm");
    for (const repository of this.executionRepository ? [this.executionRepository] : this.repositories) {
      await repository.cancelExpiredExecutions({ requestId: crypto.randomUUID(), now,
        ...(this.spaceId ? { spaceId: this.spaceId } : {}) });
      const candidates = await repository.claimTimeoutStops({
        requestId: crypto.randomUUID(), now, ...(this.spaceId ? { spaceId: this.spaceId } : {}),
      }) as Array<AutomationOccurrenceRow & {
        run_metadata_json: Record<string, unknown>;
      }>;
      for (const occurrence of candidates) {
        this.bind(occurrence, repository);
        const metadata = occurrence.run_metadata_json;
        const machineId = typeof metadata.machineId === "string" ? metadata.machineId.trim() : "";
        const observation = metadata.hostname ?? metadata.hostId;
        const hostId = typeof observation === "string" ? observation.trim() : "";
        const executionKey = typeof metadata.executionKey === "string" ? metadata.executionKey.trim() : "";
        const timeoutMessage = `Scheduled Agent exceeded the ${Math.ceil(
          occurrence.execution_timeout_ms / 60_000,
        )}-minute execution deadline`;
        if (!machineId || !executionKey) {
          await repository.recordTimeout({ requestId: crypto.randomUUID(),
            occurrenceId: occurrence.id, taskId: occurrence.task_id, runId: occurrence.run_id,
            expectedAttempts: occurrence.attempts,
            now, code: "scheduled_run_timeout_unroutable",
            message: `${timeoutMessage}, but its exact machine execution route is unavailable` });
          continue;
        }
        const controlId = `scheduled:cancel-stop:${occurrence.id}:${occurrence.attempts}`.slice(0, 200);
        try {
          await issueStop({ occurrence,
            machineId, hostId, executionKey, controlId });
          // Cancellation has already revoked execution and released occupancy.
          // Only an authenticated daemon report confirms physical cleanup.
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          await repository.recordTimeout({ requestId: crypto.randomUUID(),
          occurrenceId: occurrence.id, taskId: occurrence.task_id, runId: occurrence.run_id,
          expectedAttempts: occurrence.attempts,
          now, code: "scheduled_run_timeout_retry",
          message: `${timeoutMessage}; stop dispatch failed: ${detail}`.slice(0, 1_000) });
        }
      }
      await repository.finalizeOrphanedRuns({ requestId: crypto.randomUUID(), now,
        cutoff: new Date(nowDate.getTime() - 2 * 60_000).toISOString(),
        ...(this.spaceId ? { spaceId: this.spaceId } : {}) });
    }
  }
}
