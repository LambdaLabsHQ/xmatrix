import { MACHINE_CLI_RELEASE_CAPABILITY, MACHINE_CLI_UPDATE_CHECK_CAPABILITY, MACHINE_CLI_UPDATE_CHECK_COALESCE_MS,
  parseMachineCliUpdateStatus, type CliReleaseChannel, type MachineCliUpdateStatus } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";

/** Owners one read may return; the rest are told on the next pass. */
const CLI_RELEASE_OWNER_ROWS = 1_000;

/**
 * The owners with an online daemon that updates itself on a CLI release
 * notice, follows `channel` and reports a version other than `version`. Their
 * Runtime cells are the ones to tell; each cell sends the notice only to the
 * sockets it holds that are actually behind. The daemon's own report is the
 * only state: once it reconnects on the new version it is no longer a target.
 */
export async function readCliReleaseOwners(database: AuthorityDatabase, input: {
  requestId: string; channel: CliReleaseChannel; version: string; limit?: number;
}): Promise<string[]> {
  const limit = Math.max(1, Math.min(input.limit ?? CLI_RELEASE_OWNER_ROWS, CLI_RELEASE_OWNER_ROWS));
  return database.transaction({ requestId: input.requestId, operation: "machine-control.cli-release-owners",
    statement: "single_read" }, async (tx) => {
    const rows = await tx.query<QueryResultRow>({ name: "machine_cli_release_owners_v1", text: `SELECT
      DISTINCT daemon.owner_user_id
      FROM data.machine_daemons daemon
      WHERE daemon.status='online' AND daemon.capabilities_json ? $1
        AND daemon.metadata_json->>'xmatrixDaemonVersion' IS DISTINCT FROM $2
        AND (daemon.metadata_json->>'xmatrixDaemonVersion' LIKE '%-beta.%')=$3
      ORDER BY daemon.owner_user_id LIMIT $4`,
    values: [MACHINE_CLI_RELEASE_CAPABILITY, input.version, input.channel === "dev", limit],
    maxRows: limit });
    return rows.map(row => String(row.owner_user_id));
  });
}

export type MachineCliUpdateCheckDecision =
  | { outcome: "checking"; coalesced: boolean; daemonVersion?: string; cliUpdate: MachineCliUpdateStatus;
    route?: { daemonId: string; hostId: string } }
  | { outcome: "offline" } | { outcome: "conflict" }
  | { outcome: "unsupported" | "self_update_disabled"; daemonVersion?: string };

/**
 * Decides, in one short transaction, whether the owner's request to check a
 * Machine's CLI update goes to its daemon. A check asked within the last
 * minute is still the latest word: the request joins it and nothing is sent,
 * so views opened at once never fan out into repeated checks. Otherwise the
 * daemon's `cliUpdate` becomes `checking` now, and the caller sends the check
 * to `route`; the daemon's own reports replace that state from there.
 */
export async function requestMachineCliUpdateCheck(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string; at: string;
}): Promise<MachineCliUpdateCheckDecision> {
  return database.transaction({ requestId: input.requestId, operation: "machine-control.cli-update-check" },
    async (tx) => {
      const rows = await tx.query<QueryResultRow>({ name: "machine_cli_update_check_daemon_v1", text: `SELECT
        daemon_id,hostname,capabilities_json,metadata_json FROM data.machine_daemons
        WHERE owner_user_id=$1 AND machine_id=$2 AND status='online' ORDER BY daemon_id LIMIT 2 FOR UPDATE`,
      values: [input.ownerUserId, input.machineId], maxRows: 2 });
      if (rows.length === 0) return { outcome: "offline" };
      if (rows.length > 1) return { outcome: "conflict" };
      const row = rows[0]!;
      const capabilities = Array.isArray(row.capabilities_json) ? row.capabilities_json as unknown[] : [];
      const metadata = (row.metadata_json ?? {}) as Record<string, unknown>;
      const version = typeof metadata.xmatrixDaemonVersion === "string"
        ? { daemonVersion: metadata.xmatrixDaemonVersion } : {};
      if (!capabilities.includes(MACHINE_CLI_UPDATE_CHECK_CAPABILITY)) return { outcome: "unsupported", ...version };
      if (!capabilities.includes(MACHINE_CLI_RELEASE_CAPABILITY)) return { outcome: "self_update_disabled", ...version };
      const latest = parseMachineCliUpdateStatus(metadata.cliUpdate);
      if (latest && Date.parse(input.at) - Date.parse(latest.at) < MACHINE_CLI_UPDATE_CHECK_COALESCE_MS) {
        return { outcome: "checking", coalesced: true, cliUpdate: latest, ...version };
      }
      const cliUpdate: MachineCliUpdateStatus = { state: "checking", at: new Date(input.at).toISOString() };
      await tx.query({ name: "machine_cli_update_check_record_v1", text: `UPDATE data.machine_daemons
        SET metadata_json=jsonb_set(metadata_json,'{cliUpdate}',$2::jsonb) WHERE daemon_id=$1`,
      values: [row.daemon_id, JSON.stringify(cliUpdate)], maxRows: 0 });
      return { outcome: "checking", coalesced: false, cliUpdate, ...version,
        route: { daemonId: String(row.daemon_id), hostId: String(row.hostname ?? "") } };
    });
}

/**
 * Records what the daemon says its CLI update is doing, for a connection that
 * declared update checks. A report older than the stored state does not
 * overwrite it.
 */
export async function recordMachineCliUpdateStatus(tx: DatabaseTransaction, input: {
  daemonId: string; connectionEpoch: number | string; status: MachineCliUpdateStatus;
}): Promise<void> {
  await tx.query({ name: "machine_cli_update_status_observation_v1", text: `UPDATE data.machine_daemons
    SET metadata_json=jsonb_set(metadata_json,'{cliUpdate}',$3::jsonb)
    WHERE daemon_id=$1 AND connection_epoch=$2 AND status='online' AND capabilities_json ? $5
      AND (metadata_json->'cliUpdate'->>'at' IS NULL
        OR (metadata_json->'cliUpdate'->>'at')::timestamptz<=$4::timestamptz)`,
  values: [input.daemonId, input.connectionEpoch, JSON.stringify(input.status), input.status.at,
    MACHINE_CLI_UPDATE_CHECK_CAPABILITY], maxRows: 0 });
}

/**
 * The requested check recorded at `requestedAt` never reached the daemon:
 * that request's `checking` becomes `failed` with why, so no view waits on a
 * check nobody is running. A daemon report since then is left as it is.
 */
export async function failMachineCliUpdateCheck(database: AuthorityDatabase, input: {
  requestId: string; daemonId: string; requestedAt: string; error: string;
}): Promise<MachineCliUpdateStatus> {
  const failed: MachineCliUpdateStatus = { state: "failed", error: input.error, at: input.requestedAt };
  await database.transaction({ requestId: input.requestId, operation: "machine-control.cli-update-check-failed" },
    tx => tx.query({ name: "machine_cli_update_check_failed_v1", text: `UPDATE data.machine_daemons
      SET metadata_json=jsonb_set(metadata_json,'{cliUpdate}',$2::jsonb)
      WHERE daemon_id=$1 AND metadata_json->'cliUpdate'->>'state'='checking'
        AND metadata_json->'cliUpdate'->>'at'=$3`,
    values: [input.daemonId, JSON.stringify(failed), input.requestedAt], maxRows: 0 }));
  return failed;
}
