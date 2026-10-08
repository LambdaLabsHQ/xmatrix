import { HARNESS_ACTION_SETTLE_MS, MACHINE_HARNESS_RELEASE_CAPABILITY, parseHarnessActionRequest, parseHarnessActionResult,
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

/**
 * Columns a status is read from. `abandoned` is a claimed action whose lease
 * lapsed and that is older than HARNESS_ACTION_SETTLE_MS: no daemon can still
 * be running it, so it reads as expired instead of running forever. A late
 * result still completes the command and replaces this reading.
 */
export function statusColumns(settleParameter: number): string {
  return `payload_json,status,result_json,created_at,completed_at,expires_at<=clock_timestamp() AS expired,
    (status='leased' AND lease_until<=clock_timestamp()
      AND created_at<=clock_timestamp()-($${settleParameter}::integer*interval '1 millisecond')) AS abandoned`;
}

/** When a Machine action was requested and, if it was, completed. */
export function actionTimes(row: QueryResultRow): { requestedAt?: string; completedAt?: string } {
  const at = (value: unknown) => value ? new Date(value as Date | string).toISOString() : undefined;
  const requestedAt = at(row.created_at), completedAt = at(row.completed_at);
  return { ...(requestedAt ? { requestedAt } : {}), ...(completedAt ? { completedAt } : {}) };
}

function harnessActionStatus(row: QueryResultRow): HarnessActionStatus {
  const issued = parseHarnessActionRequest(row.payload_json);
  const { requestedAt, completedAt } = actionTimes(row);
  const base = { controlId: String(row.command_id), presetId: issued.presetId, action: issued.action,
    ...(requestedAt ? { requestedAt } : {}) };
  if (row.status === "completed") {
    const result = parseHarnessActionResult((row.result_json as Record<string, unknown>)?.result, issued);
    return { ...base, status: result.status, result, ...(completedAt ? { completedAt } : {}),
      ...(result.status === "succeeded" ? {} : { error: boundedError(result) }) };
  }
  return { ...base, ...unsettledActionStatus(row, "check the inventory to see what changed") };
}

/**
 * A Machine action that has no completed result: failed delivery, expired
 * before a daemon claimed it, abandoned by a daemon that stopped answering,
 * or still queued or running. `recheck` tells the owner how to see what an
 * abandoned action changed.
 */
export function unsettledActionStatus(row: QueryResultRow, recheck: string): {
  status: "failed" | "expired" | "running" | "queued"; error?: string; completedAt?: string;
} {
  const { completedAt } = actionTimes(row);
  if (row.status === "failed") return { status: "failed", error: "The daemon could not run the action",
    ...(completedAt ? { completedAt } : {}) };
  if (row.status === "pending" && row.expired === true) return { status: "expired",
    error: "The machine did not pick up the action within 10 minutes, so it was not run" };
  if (row.abandoned === true) return { status: "expired",
    error: `The machine stopped responding before it reported a result; ${recheck}` };
  return { status: row.status === "leased" ? "running" : "queued" };
}

/** The owner's view of one harness action; anything else reads as missing. */
export async function readHarnessActionStatus(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; controlId: string;
}): Promise<HarnessActionStatus | { controlId: string; status: "missing" }> {
  return database.transaction({ requestId: input.requestId, operation: "machine-control.harness-action-status" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_harness_action_status_v2", text: `SELECT
        command_id,${statusColumns(3)}
        FROM data.machine_daemon_commands WHERE command_id=$1 AND owner_user_id=$2
          AND command_type='harness_action' LIMIT 1`,
      values: [input.controlId, input.ownerUserId, HARNESS_ACTION_SETTLE_MS], maxRows: 1 });
      const row = rows[0];
      return row ? harnessActionStatus(row) : { controlId: input.controlId, status: "missing" };
    });
}

/** Actions the owner asks for from Machines; Hub's own `release` notices and sign-ins are not listed. */
const LISTED_ACTIONS = ["install", "update", "uninstall", "auto_update_on", "auto_update_off", "refresh"];
const RECENT_WINDOW_MS = 24 * 60 * 60_000;
const RECENT_LIMIT = 64;

/**
 * The latest owner-requested action per preset on one Machine in the last day,
 * so a page opened later still shows what became of it. Read-only: the same
 * settlement as {@link readHarnessActionStatus}, never a new fact.
 */
export async function readRecentHarnessActions(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string;
}): Promise<HarnessActionStatus[]> {
  return database.transaction({ requestId: input.requestId, operation: "machine-control.harness-action-recent" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_harness_action_recent_v1", text: `SELECT
        DISTINCT ON (payload_json->>'presetId') command_id,${statusColumns(6)}
        FROM data.machine_daemon_commands WHERE owner_user_id=$1 AND machine_id=$2
          AND command_type='harness_action' AND payload_json->>'action'=ANY($3::text[])
          AND created_at>clock_timestamp()-($4::integer*interval '1 millisecond')
        ORDER BY payload_json->>'presetId',created_at DESC,command_id DESC LIMIT $5`,
      values: [input.ownerUserId, input.machineId, LISTED_ACTIONS, RECENT_WINDOW_MS, RECENT_LIMIT,
        HARNESS_ACTION_SETTLE_MS], maxRows: RECENT_LIMIT });
      return rows.map(harnessActionStatus);
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
