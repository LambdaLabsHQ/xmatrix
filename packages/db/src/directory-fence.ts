import type { QueryResultRow } from "pg";
import type { AuthorityDatabase } from "./contracts.js";
import type { DatabaseRequestContext } from "./context.js";
import { DatabaseContractError } from "./errors.js";
import { boundedDatabaseIdentifier, positiveDatabaseInteger } from "./identifiers.js";

/** A route publication must name its Space's current physical placement. */
export function requireDirectoryPlacement(
  row: { shard_id: unknown; placement_epoch: unknown } | undefined,
  mutation: { shardId: string; placementEpoch: number }, staleMessage: string,
): void {
  if (!row) throw new DatabaseContractError("Space placement is unavailable");
  if (boundedDatabaseIdentifier(row.shard_id, "shardId") !== mutation.shardId ||
      positiveDatabaseInteger(row.placement_epoch, "placementEpoch") !== mutation.placementEpoch) {
    throw new DatabaseContractError(staleMessage);
  }
}

/** Global directory operations cannot acquire a Space placement context. */
export type DirectoryRequestContext = Omit<DatabaseRequestContext, "placement">;

/** Directory publishers must use the uncached global authority. */
export class DirectoryAuthority {
  constructor(protected readonly directoryDatabase: AuthorityDatabase, directoryName: string) {
    if (directoryDatabase.cacheMode !== "disabled") {
      throw new DatabaseContractError(`${directoryName} directory requires a cache-disabled database`);
    }
  }
}

/** The physical route fields shared by global directory projections. */
export interface DirectoryRouteRow extends QueryResultRow {
  space_id: string;
  shard_id: string;
  placement_epoch: string | number;
  route_version: string | number;
}
