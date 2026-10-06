import {
  PostgresRuntimeRepository,
  RuntimeControlError,
  type AuthorityDatabase,
} from "@xmatrix/db";

import type { ScheduledRunCleanup } from "./relay-authority-scheduled-run-cleanup";
import type { AutomationOccurrenceRow } from "./automation-occurrence-rows";
import type { Env } from "./types";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";

type RuntimeRepository = Pick<PostgresRuntimeRepository, "getInstance" | "mutate">;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Scheduled dispatch cleanup closes against the same PostgreSQL Run/Instance authority. */
export class PostgresScheduledRunCleanup implements ScheduledRunCleanup {
  private readonly repository: RuntimeRepository;

  constructor(env: Env, dependencies: {
    database?: AuthorityDatabase;
    repository?: RuntimeRepository;
  } = {}) {
    if (dependencies.repository) {
      this.repository = dependencies.repository;
      return;
    }
    this.repository = new PostgresRuntimeRepository(
      dependencies.database ?? createPostgresAuthorityDatabase(env, {
        applicationName: "xmatrix-hub-scheduled-run-cleanup",
        statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
      }),
    );
  }

  async abandon(occurrence: AutomationOccurrenceRow, reason: string): Promise<void> {
    let instance: Record<string, unknown>;
    try {
      const result = await this.repository.getInstance({
        requestId: `scheduled:cleanup-read:${occurrence.instance_id}`.slice(0, 200),
        instanceId: occurrence.instance_id,
        actorUserId: occurrence.owner_user_id,
      });
      const value = record(result.instance);
      if (!value) throw new Error("PostgreSQL scheduled cleanup returned an invalid Instance");
      instance = value;
    } catch (error) {
      if (error instanceof RuntimeControlError && error.code === "not_found") return;
      throw error;
    }
    if (instance.runId !== occurrence.run_id || instance.status === "offline") return;
    const version = Number(instance.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error(
      "PostgreSQL scheduled cleanup returned an invalid Instance version",
    );
    try {
      await this.repository.mutate({
        commandId: `scheduled:abandon:${occurrence.instance_id}`.slice(0, 200),
        actorUserId: occurrence.owner_user_id,
        at: new Date().toISOString(),
        kind: "instance_transition",
        instanceId: occurrence.instance_id,
        expectedRunId: occurrence.run_id,
        expectedVersion: version,
        status: "offline",
        terminal: true,
      });
    } catch (error) {
      console.warn("Automation PostgreSQL Run cleanup did not complete", {
        occurrenceId: occurrence.id, runId: occurrence.run_id, reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
