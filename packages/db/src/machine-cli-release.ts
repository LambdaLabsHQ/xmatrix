import { MACHINE_CLI_RELEASE_CAPABILITY, type CliReleaseChannel } from "@xmatrix/protocol";
import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";

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
