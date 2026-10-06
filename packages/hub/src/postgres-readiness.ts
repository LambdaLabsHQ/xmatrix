import {
  createAuthorityDatabase,
  type AuthorityDatabase,
  type AuthorityDatabaseOptions,
} from "@xmatrix/db";
import type { Hono } from "hono";

import {
  recordPostgresReadinessSummary,
} from "./postgres-observability";
import { createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import type { Env } from "./types";

export const POSTGRES_READINESS_PATH = "/health/postgres";

type DatabaseFactory = (options: AuthorityDatabaseOptions) => AuthorityDatabase;

export interface PostgresReadinessDependencies {
  createDatabase?: DatabaseFactory;
  randomUUID?: () => string;
}

function boundedSlowQueryMs(raw: string | undefined): number {
  if (!raw || !/^\d+$/u.test(raw.trim())) return 1_000;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 60_000 ? parsed : 1_000;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error &&
      typeof error.code === "string") {
    return error.code;
  }
  return "DATABASE_ERROR";
}

function unavailable(): Response {
  return Response.json({
    status: "unavailable",
    service: "xmatrix-postgres",
    code: "postgres_unavailable",
    retryable: true,
  }, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}

export function registerIndexRoutesPostgresReadiness(
  app: Hono<{ Bindings: Env }>,
  dependencies: PostgresReadinessDependencies = {},
): void {
  const createDatabase = dependencies.createDatabase ?? createAuthorityDatabase;
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());

  app.get(POSTGRES_READINESS_PATH, async (context) => {
    const binding = context.env.RELAY_POSTGRES;
    const shardId = context.env.RELAY_POSTGRES_SHARD_ID?.trim();
    if (!binding?.connectionString || !shardId) {
      recordPostgresReadinessSummary({
        env: context.env,
        shardId: shardId || "other",
        outcome: "error",
        durationMs: 0,
        errorCode: "BINDING_UNAVAILABLE",
      });
      return unavailable();
    }

    const startedAt = performance.now();
    let activeShardId = shardId;
    try {
      const fleet = createPostgresAuthorityFleet(context.env, {
        applicationName: "xmatrix-hub-readiness",
        connectTimeoutMs: 3_000,
        statementTimeoutMs: 3_000,
        transactionTimeoutMs: 5_000,
        lockTimeoutMs: 1_000,
        slowQueryMs: boundedSlowQueryMs(context.env.RELAY_AUTHORITY_OBSERVABILITY_SLOW_MS),
      }, { createDatabase });
      const shardResults = await Promise.all(fleet.physicalShards.map(async (physical) => {
        const shardStartedAt = performance.now();
        try {
          await physical.database.health({
            requestId: `postgres-readiness:${randomUUID()}`,
            operation: "postgres.readiness",
          });
          recordPostgresReadinessSummary({
            env: context.env,
            shardId: physical.shardId,
            outcome: "ok",
            durationMs: performance.now() - shardStartedAt,
          });
        } catch (error) {
          recordPostgresReadinessSummary({
            env: context.env,
            shardId: physical.shardId,
            outcome: "error",
            durationMs: performance.now() - shardStartedAt,
            errorCode: errorCode(error),
          });
          return { shardId: physical.shardId, error };
        }
        return { shardId: physical.shardId, error: null };
      }));
      const failed = shardResults.find((result) => result.error);
      if (failed) {
        throw Object.assign(new Error("PostgreSQL shard readiness failed"), {
          cause: failed.error,
          shardId: failed.shardId,
        });
      }
      return context.json({
        status: "ready",
        service: "xmatrix-postgres",
        cacheMode: fleet.database.cacheMode,
      }, 200, { "cache-control": "no-store" });
    } catch (error) {
      if (!(error && typeof error === "object" && "shardId" in error)) {
        recordPostgresReadinessSummary({
          env: context.env,
          shardId: activeShardId,
          outcome: "error",
          durationMs: performance.now() - startedAt,
          errorCode: errorCode(error),
        });
      }
      return unavailable();
    }
  });
}
