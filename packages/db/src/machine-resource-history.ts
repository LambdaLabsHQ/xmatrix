import type { QueryResultRow } from "pg";
import { MACHINE_RESOURCE_HISTORY_RANGES, type MachineResourceHistory, type MachineResourceHistoryRange }
  from "@xmatrix/protocol";

import type { AuthorityDatabase } from "./contracts.js";
import { ControlError } from "./control-error.js";

const RANGE_HOURS: Record<MachineResourceHistoryRange, number> = {
  "1h": 1, "24h": 24, "7d": 7 * 24, "30d": 30 * 24, "90d": 90 * 24,
};
/** Minute rows answer short ranges; longer ones read hourly rollups. */
const MINUTE_RANGES = new Set<MachineResourceHistoryRange>(["1h", "24h"]);

/** Minute samples are kept this long, hourly rollups longer. */
export const MACHINE_RESOURCE_MINUTE_RETENTION_HOURS = 7 * 24;
export const MACHINE_RESOURCE_HOURLY_RETENTION_HOURS = 90 * 24;
/** Each maintenance pass re-rolls this many completed hours, so late samples
 * and a missed pass still land in their hour. */
const ROLLUP_HOURS = 6;
/** One pass deletes at most this many expired rows per table. */
const PRUNE_BATCH = 50_000;

export class MachineResourceHistoryError extends ControlError {
  override name = "MachineResourceHistoryError";
  declare readonly code: "invalid_resource_range" | "machine_not_found";
  constructor(code: "invalid_resource_range" | "machine_not_found", status: number, message: string) {
    super(code, status, message);
  }
}

export function parseMachineResourceHistoryRange(value: unknown): MachineResourceHistoryRange {
  if (value === undefined || value === null || value === "") return "24h";
  if (typeof value === "string" && (MACHINE_RESOURCE_HISTORY_RANGES as readonly string[]).includes(value)) {
    return value as MachineResourceHistoryRange;
  }
  throw new MachineResourceHistoryError("invalid_resource_range", 400,
    `range must be one of ${MACHINE_RESOURCE_HISTORY_RANGES.join(", ")}`);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : null;
}

/** Owner-only: a Machine's load over a range. Another owner's Machine reads as missing. */
export async function readMachineResourceHistory(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string; range: MachineResourceHistoryRange; now?: number;
}): Promise<MachineResourceHistory> {
  const to = new Date(input.now ?? Date.now());
  const from = new Date(to.getTime() - RANGE_HOURS[input.range] * 3_600_000);
  const minute = MINUTE_RANGES.has(input.range);
  return database.transaction({ requestId: input.requestId, operation: "machine.resource-history" }, async (tx) => {
    const machine = await tx.query<QueryResultRow>({ name: "machine_resource_history_owner_v1", text: `SELECT 1
      FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2`,
    values: [input.ownerUserId, input.machineId], maxRows: 1 });
    if (!machine[0]) throw new MachineResourceHistoryError("machine_not_found", 404, "Machine not found");
    const rows = minute
      ? await tx.query<QueryResultRow>({ name: "machine_resource_history_minutes_v1", text: `SELECT
          observed_at AS at, cpu_usage_percent AS cpu, load_average_1m AS load,
          100 - memory_available_bytes::float8 * 100 / NULLIF(memory_total_bytes,0) AS memory,
          100 - disk_available_bytes::float8 * 100 / NULLIF(disk_total_bytes,0) AS disk
        FROM data.machine_resource_samples
        WHERE owner_user_id=$1 AND machine_id=$2 AND observed_at>$3 AND observed_at<=$4
        ORDER BY observed_at`,
      values: [input.ownerUserId, input.machineId, from.toISOString(), to.toISOString()],
      maxRows: RANGE_HOURS[input.range] * 60 + 1 })
      // Rolled-up hours, plus hours maintenance has not rolled up yet, aggregated
      // from the minute rows that are still there.
      : await tx.query<QueryResultRow>({ name: "machine_resource_history_hours_v1", text: `
        WITH rolled AS (
          SELECT hour_start AS at, cpu_usage_percent_avg AS cpu, cpu_usage_percent_max AS cpu_max,
            load_average_1m_avg AS load, memory_used_percent_avg AS memory,
            memory_used_percent_max AS memory_max, disk_used_percent_max AS disk
          FROM data.machine_resource_hourly
          WHERE owner_user_id=$1 AND machine_id=$2 AND hour_start>=date_trunc('hour',$3::timestamptz)
            AND hour_start<=$4
        ), pending AS (
          SELECT date_trunc('hour',observed_at) AS at, avg(cpu_usage_percent) AS cpu,
            max(cpu_usage_percent) AS cpu_max, avg(load_average_1m) AS load,
            avg(100 - memory_available_bytes::float8 * 100 / NULLIF(memory_total_bytes,0)) AS memory,
            max(100 - memory_available_bytes::float8 * 100 / NULLIF(memory_total_bytes,0)) AS memory_max,
            max(100 - disk_available_bytes::float8 * 100 / NULLIF(disk_total_bytes,0)) AS disk
          FROM data.machine_resource_samples
          WHERE owner_user_id=$1 AND machine_id=$2
            AND observed_at>=GREATEST(date_trunc('hour',$3::timestamptz),
              COALESCE((SELECT max(at) + interval '1 hour' FROM rolled), '-infinity'))
            AND observed_at<=$4
          GROUP BY 1
        )
        SELECT * FROM rolled UNION ALL SELECT * FROM pending ORDER BY at`,
      values: [input.ownerUserId, input.machineId, from.toISOString(), to.toISOString()],
      maxRows: RANGE_HOURS[input.range] + 2 });
    return {
      machineId: input.machineId, range: input.range, resolution: minute ? "minute" : "hour",
      from: from.toISOString(), to: to.toISOString(),
      points: rows.map((row) => ({
        at: new Date(row.at as string | Date).toISOString(),
        cpuPercent: numberOrNull(row.cpu),
        ...(minute ? {} : { cpuPercentMax: numberOrNull(row.cpu_max), memoryPercentMax: numberOrNull(row.memory_max) }),
        memoryPercent: numberOrNull(row.memory),
        diskPercent: numberOrNull(row.disk),
        loadAverage1m: numberOrNull(row.load),
      })),
    };
  });
}

/** Rolls the last completed hours into hourly rows and deletes expired rows,
 * a bounded batch per table. Idempotent: a repeated or overlapping pass
 * rewrites the same hours from the same minute rows. */
export async function maintainMachineResourceHistory(database: AuthorityDatabase, input: {
  requestId: string; now?: number;
}): Promise<{ rolledUp: number; prunedSamples: number; prunedHours: number }> {
  const now = new Date(input.now ?? Date.now());
  return database.transaction({ requestId: input.requestId, operation: "machine.resource-history-maintain" }, async (tx) => {
    const rolled = await tx.query<QueryResultRow>({ name: "machine_resource_history_rollup_v1", text: `
      INSERT INTO data.machine_resource_hourly (owner_user_id,machine_id,hour_start,sample_count,
        cpu_usage_percent_avg,cpu_usage_percent_max,load_average_1m_avg,load_average_1m_max,
        memory_used_percent_avg,memory_used_percent_max,swap_used_percent_avg,disk_used_percent_max)
      SELECT owner_user_id, machine_id, date_trunc('hour',observed_at), count(*),
        avg(cpu_usage_percent), max(cpu_usage_percent), avg(load_average_1m), max(load_average_1m),
        avg(100 - memory_available_bytes::float8 * 100 / NULLIF(memory_total_bytes,0)),
        max(100 - memory_available_bytes::float8 * 100 / NULLIF(memory_total_bytes,0)),
        avg(100 - swap_free_bytes::float8 * 100 / NULLIF(swap_total_bytes,0)),
        max(100 - disk_available_bytes::float8 * 100 / NULLIF(disk_total_bytes,0))
      FROM data.machine_resource_samples
      WHERE observed_at>=date_trunc('hour',$1::timestamptz) - make_interval(hours => $2)
        AND observed_at<date_trunc('hour',$1::timestamptz)
      GROUP BY 1,2,3
      ON CONFLICT (owner_user_id,machine_id,hour_start) DO UPDATE SET
        sample_count=EXCLUDED.sample_count,
        cpu_usage_percent_avg=EXCLUDED.cpu_usage_percent_avg,
        cpu_usage_percent_max=EXCLUDED.cpu_usage_percent_max,
        load_average_1m_avg=EXCLUDED.load_average_1m_avg,
        load_average_1m_max=EXCLUDED.load_average_1m_max,
        memory_used_percent_avg=EXCLUDED.memory_used_percent_avg,
        memory_used_percent_max=EXCLUDED.memory_used_percent_max,
        swap_used_percent_avg=EXCLUDED.swap_used_percent_avg,
        disk_used_percent_max=EXCLUDED.disk_used_percent_max
      RETURNING 1`,
    values: [now.toISOString(), ROLLUP_HOURS], maxRows: 1_000_000 });
    const prunedSamples = await tx.query<QueryResultRow>({ name: "machine_resource_history_prune_samples_v1", text: `
      DELETE FROM data.machine_resource_samples WHERE ctid IN (SELECT ctid FROM data.machine_resource_samples
        WHERE observed_at<$1::timestamptz - make_interval(hours => $2) LIMIT $3) RETURNING 1`,
    values: [now.toISOString(), MACHINE_RESOURCE_MINUTE_RETENTION_HOURS, PRUNE_BATCH], maxRows: PRUNE_BATCH });
    const prunedHours = await tx.query<QueryResultRow>({ name: "machine_resource_history_prune_hours_v1", text: `
      DELETE FROM data.machine_resource_hourly WHERE ctid IN (SELECT ctid FROM data.machine_resource_hourly
        WHERE hour_start<$1::timestamptz - make_interval(hours => $2) LIMIT $3) RETURNING 1`,
    values: [now.toISOString(), MACHINE_RESOURCE_HOURLY_RETENTION_HOURS, PRUNE_BATCH], maxRows: PRUNE_BATCH });
    return { rolledUp: rolled.length, prunedSamples: prunedSamples.length, prunedHours: prunedHours.length };
  });
}
