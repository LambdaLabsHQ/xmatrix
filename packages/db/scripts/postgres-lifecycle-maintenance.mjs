#!/usr/bin/env node

import process from "node:process";
import { Client } from "pg";

import { runIfInvoked, withClient, withClientTransaction } from "./cli.mjs";

const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_BUDGET_MS = 30_000;
const MAX_MANUAL_ROWS = 100_000;

function integer(raw, name, fallback, maximum) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

export function parseLifecycleOptions(argv) {
  const values = new Map();
  let dryRun = false;
  for (const argument of argv) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    const match = /^--(batch-size|max-rows|budget-ms)=(\d+)$/u.exec(argument);
    if (!match || values.has(match[1])) throw new Error(`Unknown or duplicate option: ${argument}`);
    values.set(match[1], match[2]);
  }
  return Object.freeze({
    dryRun,
    batchSize: integer(values.get("batch-size"), "batch-size", DEFAULT_BATCH_SIZE, 1_000),
    maxRows: integer(values.get("max-rows"), "max-rows", DEFAULT_MAX_ROWS, MAX_MANUAL_ROWS),
    budgetMs: integer(values.get("budget-ms"), "budget-ms", DEFAULT_BUDGET_MS, 90_000),
  });
}

// Evidence reads scan tables no index serves: `data.outbox` alone took 4 s on the
// production origin, and the five oldest-row scans together exceeded the 5 s delete
// timeout before any delete began. They run one at a time in a read-only
// transaction with their own ceiling; the deletes keep the tighter one.
const SNAPSHOT_STATEMENT_TIMEOUT = "30s";
const DELETE_STATEMENT_TIMEOUT = "5s";

async function snapshotQuery(client, label, text, values) {
  try {
    return await client.query(text, values);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`lifecycle snapshot ${label}: ${message}`, { cause: error });
  }
}

function snapshot(client) {
  return withClientTransaction(client, async () => {
    await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = '${SNAPSHOT_STATEMENT_TIMEOUT}'`);
    return readSnapshot(client);
  });
}

async function oldest(client, relation, column) {
  const result = await snapshotQuery(client, `oldest ${relation}`,
    `SELECT MIN(${column}) AS oldest_at FROM ${relation}`);
  return result.rows[0]?.oldest_at ?? null;
}

async function readSnapshot(client) {
  const relations = await snapshotQuery(client, "relations",
    `SELECT namespace.nspname||'.'||relation.relname AS relation,
        GREATEST(relation.reltuples,0)::bigint AS estimated_rows,
        pg_total_relation_size(relation.oid)::bigint AS total_bytes,
        pg_indexes_size(relation.oid)::bigint AS index_bytes
      FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE (namespace.nspname='data'
        AND relation.relname IN (
          'idempotency_keys','message_sequence_reservations','agent_message_executions','outbox','message_mutations'
        )) OR (namespace.nspname='control' AND relation.relname='scoped_control_command_replays')
      ORDER BY relation.relname`);
  // One scan of the outbox serves both its per-status counts and its oldest row.
  const outbox = await snapshotQuery(client, "outbox by status",
    `SELECT status,COUNT(*)::bigint AS estimated_rows,MIN(created_at) AS oldest_at,
        MIN(available_at) AS oldest_available_at
      FROM data.outbox GROUP BY status ORDER BY status`);
  const outboxOldest = outbox.rows.reduce((earliest, row) =>
    row.oldest_at !== null && row.oldest_at !== undefined &&
      (earliest === null || row.oldest_at < earliest) ? row.oldest_at : earliest, null);
  const ages = {
    idempotency_oldest_at: await oldest(client, "data.idempotency_keys", "created_at"),
    sequence_reservation_oldest_at:
      await oldest(client, "data.message_sequence_reservations", "created_at"),
    outbox_oldest_at: outboxOldest,
    message_execution_oldest_at: await oldest(client, "data.agent_message_executions", "created_at"),
    mutation_oldest_at: await oldest(client, "data.message_mutations", "occurred_at"),
  };
  const expired = await snapshotQuery(client, "expired rows",
    `SELECT
        (SELECT COUNT(*)::integer FROM (
          SELECT 1 FROM data.idempotency_keys WHERE expires_at<=clock_timestamp()
          ORDER BY expires_at,space_id,idempotency_key LIMIT $1
        ) bounded) AS idempotency_rows,
        (SELECT COUNT(*)::integer FROM (
          SELECT 1 FROM data.message_sequence_reservations WHERE expires_at<=clock_timestamp()
          ORDER BY expires_at,space_id,command_id LIMIT $1
        ) bounded) AS sequence_reservation_rows,
        (SELECT COUNT(*)::integer FROM (
          SELECT 1 FROM data.agent_message_executions WHERE expires_at<=clock_timestamp()
          ORDER BY expires_at,binding_id LIMIT $1
        ) bounded) AS message_execution_rows,
        (SELECT COUNT(*)::integer FROM (
          SELECT 1 FROM control.scoped_control_command_replays WHERE expires_at<=now()
          ORDER BY expires_at,scope_kind,scope_id,command_id LIMIT $1
        ) bounded) AS scoped_command_replay_rows`, [MAX_MANUAL_ROWS + 1]);
  return {
    relations: relations.rows,
    oldest: ages,
    outboxByStatus: outbox.rows,
    expiredIdempotencyRowsCapped: Number(expired.rows[0]?.idempotency_rows ?? 0),
    expiredSequenceReservationRowsCapped: Number(
      expired.rows[0]?.sequence_reservation_rows ?? 0,
    ),
    expiredMessageExecutionRowsCapped: Number(expired.rows[0]?.message_execution_rows ?? 0),
    expiredScopedCommandReplayRowsCapped: Number(expired.rows[0]?.scoped_command_replay_rows ?? 0),
    expiredIdempotencyRowsCappedAt: MAX_MANUAL_ROWS + 1,
  };
}

async function deleteBatch(client, relation, limit) {
  const statement = relation === "idempotency"
    ? `WITH expired AS MATERIALIZED (
        SELECT ctid FROM data.idempotency_keys WHERE expires_at<=clock_timestamp()
        ORDER BY expires_at,space_id,idempotency_key LIMIT $1 FOR UPDATE SKIP LOCKED
      ) DELETE FROM data.idempotency_keys target USING expired
        WHERE target.ctid=expired.ctid RETURNING 1`
    : relation === "sequence-reservation"
      ? `WITH expired AS MATERIALIZED (
          SELECT ctid FROM data.message_sequence_reservations
          WHERE expires_at<=clock_timestamp()
          ORDER BY expires_at,space_id,command_id LIMIT $1 FOR UPDATE SKIP LOCKED
        ) DELETE FROM data.message_sequence_reservations target USING expired
          WHERE target.ctid=expired.ctid RETURNING 1`
      : relation === "message-execution"
        ? `WITH expired AS MATERIALIZED (
            SELECT ctid FROM data.agent_message_executions WHERE expires_at<=clock_timestamp()
            ORDER BY expires_at,binding_id LIMIT $1 FOR UPDATE SKIP LOCKED
          ) DELETE FROM data.agent_message_executions target USING expired
            WHERE target.ctid=expired.ctid RETURNING 1`
        : relation === "wecom-install-attempt"
          ? `WITH expired AS MATERIALIZED (
              SELECT ctid FROM data.app_wecom_install_attempts WHERE expires_at<=clock_timestamp()
              ORDER BY expires_at,state_digest LIMIT $1 FOR UPDATE SKIP LOCKED
            ) DELETE FROM data.app_wecom_install_attempts target USING expired
              WHERE target.ctid=expired.ctid RETURNING 1`
          : relation === "dingtalk-company-attempt"
            ? `WITH expired AS MATERIALIZED (
                SELECT ctid FROM data.app_dingtalk_company_attempts WHERE expires_at<=clock_timestamp()
                ORDER BY expires_at,state_digest LIMIT $1 FOR UPDATE SKIP LOCKED
              ) DELETE FROM data.app_dingtalk_company_attempts target USING expired
                WHERE target.ctid=expired.ctid RETURNING 1`
            : relation === "scoped-command-replay"
              ? `WITH expired AS MATERIALIZED (
                  -- now() is stable, so the expiry index bounds the scan instead of filtering
                  -- every unexpired row of this large table.
                  SELECT ctid FROM control.scoped_control_command_replays WHERE expires_at<=now()
                  ORDER BY expires_at,scope_kind,scope_id,command_id LIMIT $1 FOR UPDATE SKIP LOCKED
                ) DELETE FROM control.scoped_control_command_replays target USING expired
                  WHERE target.ctid=expired.ctid RETURNING 1`
              : null;
  if (!statement) throw new Error("Unsupported lifecycle relation");
  await client.query("BEGIN");
  try {
    const result = await client.query(statement, [limit]);
    await client.query("COMMIT");
    return result.rowCount ?? result.rows.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function runLifecycleMaintenance(client, options, dependencies = {}) {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  await client.query("SET application_name = 'xmatrix-postgres-lifecycle-maintenance'");
  await client.query(`SET statement_timeout = '${DELETE_STATEMENT_TIMEOUT}'`);
  await client.query("SET lock_timeout = '2s'");
  const before = await snapshot(client);
  const startedAt = monotonicNow();
  const deleted = { idempotency: 0, sequenceReservation: 0, messageExecution: 0, wecomInstallAttempt: 0, dingtalkCompanyAttempt: 0, scopedCommandReplay: 0 };
  const batches = { idempotency: 0, sequenceReservation: 0, messageExecution: 0, wecomInstallAttempt: 0, dingtalkCompanyAttempt: 0, scopedCommandReplay: 0 };
  if (!options.dryRun) {
    for (const target of [
      { relation: "idempotency", key: "idempotency" },
      { relation: "sequence-reservation", key: "sequenceReservation" },
      { relation: "message-execution", key: "messageExecution" },
      { relation: "wecom-install-attempt", key: "wecomInstallAttempt" },
      { relation: "dingtalk-company-attempt", key: "dingtalkCompanyAttempt" },
      // Every reader already ignores expired replays; this only frees their rows.
      // Last, because it is the largest and must not starve the others' budget.
      { relation: "scoped-command-replay", key: "scopedCommandReplay" },
    ]) {
      while (deleted[target.key] < options.maxRows &&
          monotonicNow() - startedAt < options.budgetMs) {
        const limit = Math.min(options.batchSize, options.maxRows - deleted[target.key]);
        const count = await deleteBatch(client, target.relation, limit);
        deleted[target.key] += count;
        batches[target.key] += 1;
        if (count < limit) break;
      }
    }
  }
  const after = await snapshot(client);
  return {
    schemaVersion: 2,
    dryRun: options.dryRun,
    limits: { batchSize: options.batchSize, maxRows: options.maxRows, budgetMs: options.budgetMs },
    deletedExpiredIdempotencyRows: deleted.idempotency,
    deletedExpiredSequenceReservationRows: deleted.sequenceReservation,
    deletedExpiredMessageExecutionRows: deleted.messageExecution,
    deletedExpiredWeComInstallAttempts: deleted.wecomInstallAttempt,
    deletedExpiredDingTalkCompanyAttempts: deleted.dingtalkCompanyAttempt,
    deletedExpiredScopedCommandReplays: deleted.scopedCommandReplay,
    batches: Object.values(batches).reduce((sum, count) => sum + count, 0),
    batchesByRelation: batches,
    elapsedMs: Math.max(0, monotonicNow() - startedAt),
    before,
    after,
  };
}

async function main() {
  const options = parseLifecycleOptions(process.argv.slice(2));
  const connectionString = process.env.POSTGRES_DATABASE_URL?.trim();
  if (!connectionString) throw new Error("POSTGRES_DATABASE_URL is required");
  const client = new Client({ connectionString, connectionTimeoutMillis: 15_000 });
  await client.connect();
  const report = await withClient(client, (connected) =>
    runLifecycleMaintenance(connected, options));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

runIfInvoked(import.meta.url, main);
