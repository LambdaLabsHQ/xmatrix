import { MACHINE_HARNESS_RELEASE_CAPABILITY, parseHarnessActionRequest, parseHarnessActionResult,
  parseHarnessInventory, type HarnessActionResult, type HarnessActionStatus } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";

const ERROR_MAX = 256;

/**
 * Fold a completed action's re-probe into the Machine's inventory. A refresh
 * replaces the whole observation unless a fresher one is stored; a single
 * re-probed preset replaces only its own item in an existing observation.
 */
export async function recordHarnessActionInventory(tx: DatabaseTransaction, input: {
  ownerUserId: string; machineId: string; hostId: string; result: HarnessActionResult; at: string;
}): Promise<void> {
  const { ownerUserId, machineId, result } = input;
  if (result.inventory) {
    await tx.query({ name: "machine_harness_action_inventory_v2", text: `UPDATE data.machine_daemons
      SET metadata_json=jsonb_set(metadata_json,'{harnesses}',$3::jsonb)
      WHERE owner_user_id=$1 AND machine_id=$2
        AND (metadata_json->'harnesses'->>'capturedAt' IS NULL
          OR (metadata_json->'harnesses'->>'capturedAt')::timestamptz<$4::timestamptz)`,
    values: [ownerUserId, machineId, JSON.stringify(result.inventory), result.inventory.capturedAt], maxRows: 0 });
    return;
  }
  const item = result.item;
  if (!item) return;
  const rows = await tx.query<QueryResultRow>({ name: "machine_harness_action_item_lock_v2", text: `SELECT
    metadata_json->'harnesses' AS harnesses FROM data.machine_daemons
    WHERE owner_user_id=$1 AND machine_id=$2 FOR UPDATE`,
  values: [ownerUserId, machineId], maxRows: 1 });
  const current = parseHarnessInventory(rows[0]?.harnesses);
  // Without a full observation there is nothing an item can stand beside yet.
  if (!current) return;
  const items = current.items.some(entry => entry.id === item.id)
    ? current.items.map(entry => entry.id === item.id ? item : entry)
    : [...current.items, item];
  const next = parseHarnessInventory({ ...current, items });
  if (!next) return;
  await tx.query({ name: "machine_harness_action_item_v2", text: `UPDATE data.machine_daemons
    SET metadata_json=jsonb_set(metadata_json,'{harnesses}',$3::jsonb)
    WHERE owner_user_id=$1 AND machine_id=$2`,
  values: [ownerUserId, machineId, JSON.stringify(next)], maxRows: 0 });
}

/** The owner's view of one harness action; anything else reads as missing. */
export async function readHarnessActionStatus(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; controlId: string;
}): Promise<HarnessActionStatus | { controlId: string; status: "missing" }> {
  return database.transaction({ requestId: input.requestId, operation: "machine-control.harness-action-status" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_harness_action_status_v1", text: `SELECT
        payload_json,status,result_json,completed_at,expires_at<=clock_timestamp() AS expired
        FROM data.machine_daemon_commands WHERE command_id=$1 AND owner_user_id=$2
          AND command_type='harness_action' LIMIT 1`,
      values: [input.controlId, input.ownerUserId], maxRows: 1 });
      const row = rows[0];
      if (!row) return { controlId: input.controlId, status: "missing" };
      const issued = parseHarnessActionRequest(row.payload_json);
      const base = { controlId: input.controlId, presetId: issued.presetId, action: issued.action };
      const completedAt = row.completed_at ? new Date(row.completed_at as Date | string).toISOString() : undefined;
      if (row.status === "completed") {
        const result = parseHarnessActionResult((row.result_json as Record<string, unknown>)?.result, issued);
        return { ...base, status: result.status, result, ...(completedAt ? { completedAt } : {}),
          ...(result.status === "succeeded" ? {} : { error: boundedError(result) }) };
      }
      if (row.status === "failed") return { ...base, status: "failed", error: "The daemon could not run the action",
        ...(completedAt ? { completedAt } : {}) };
      if (row.status === "pending" && row.expired === true) return { ...base, status: "expired",
        error: "No daemon picked up the action in time" };
      return { ...base, status: row.status === "leased" ? "running" : "queued" };
    });
}

export interface HarnessReleaseTarget {
  ownerUserId: string; ownerEmail: string; machineId: string; hostId: string; daemonId: string;
}

/** A release is told again to the same Machine at most this often, so a
 * daemon that cannot reach the registry is not asked every minute. */
const RELEASE_REPEAT_INTERVAL = "30 minutes";

/**
 * Online, capable daemons whose reported inventory has the preset installed
 * but has not seen `version` as its latest, and that were not told about a
 * release of this preset recently. The daemon's own inventory is the only
 * state: once it reports the new latest version it is no longer a target.
 */
export async function readHarnessReleaseTargets(database: AuthorityDatabase, input: {
  requestId: string; presetId: string; version: string; limit?: number;
}): Promise<HarnessReleaseTarget[]> {
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 500);
  return database.transaction({ requestId: input.requestId, operation: "machine-control.harness-release-targets" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_harness_release_targets_v2", text: `SELECT
        daemon.owner_user_id,daemon.owner_email,daemon.machine_id,daemon.hostname,daemon.daemon_id
        FROM data.machine_daemons daemon
        WHERE daemon.status='online' AND daemon.capabilities_json ? $1
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(daemon.metadata_json->'harnesses'->'items')='array'
                THEN daemon.metadata_json->'harnesses'->'items' ELSE '[]'::jsonb END) item
            WHERE item->>'id'=$2 AND item->'installed'='true'::jsonb
              AND item->>'latestVersion' IS DISTINCT FROM $3)
          AND NOT EXISTS (SELECT 1 FROM data.machine_daemon_commands command
            WHERE command.owner_user_id=daemon.owner_user_id AND command.machine_id=daemon.machine_id
              AND command.command_type='harness_action' AND command.payload_json->>'presetId'=$2
              AND command.payload_json->>'action'='release'
              AND command.created_at>clock_timestamp()-$4::interval)
        ORDER BY daemon.daemon_id LIMIT $5`,
      values: [MACHINE_HARNESS_RELEASE_CAPABILITY, input.presetId, input.version, RELEASE_REPEAT_INTERVAL, limit],
      maxRows: limit });
      return rows.map(row => ({ ownerUserId: String(row.owner_user_id), ownerEmail: String(row.owner_email),
        machineId: String(row.machine_id), hostId: String(row.hostname ?? ""), daemonId: String(row.daemon_id) }));
    });
}

function boundedError(result: HarnessActionResult): string {
  if (result.status === "unsupported") return "This harness has no official recipe for that action on this platform";
  const last = result.outputTail?.trim().split("\n").at(-1)?.trim();
  const message = `${result.exitCode === undefined ? "Failed" : `Exited with code ${result.exitCode}`}${last ? `: ${last}` : ""}`;
  return message.length > ERROR_MAX ? `${message.slice(0, ERROR_MAX - 1)}…` : message;
}
