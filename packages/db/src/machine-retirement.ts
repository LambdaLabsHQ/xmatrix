import type { QueryResultRow } from "pg";

import type { AuthorityDatabase } from "./contracts.js";
import { MachineControlError } from "./machine-control.js";

/**
 * Owner-only: removes one of the owner's Machines from their account, in any
 * state. The row stays as a tombstone so history keeps the Machine's name; the
 * Machine is hidden, the Channel coordinators stop its registrations' Runs (the
 * caller wakes them after this commits), and Machine control refuses its daemon
 * until the owner rejoins it. A replay keeps the first retirement time.
 */
export async function retireMachine(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string;
}): Promise<{ machineId: string; retiredAt: string }> {
  return database.transaction({ requestId: input.requestId, operation: "machine.retire" }, async (tx) => {
    const rows = await tx.query<QueryResultRow>({ name: "machine_retire_v1", text: `UPDATE data.machines
      SET retired_at=COALESCE(retired_at,clock_timestamp()) WHERE owner_user_id=$1 AND machine_id=$2
      RETURNING retired_at`, values: [input.ownerUserId, input.machineId], maxRows: 1 });
    if (!rows[0]) throw new MachineControlError("machine_not_found", 404, "Machine not found");
    return { machineId: input.machineId, retiredAt: new Date(rows[0].retired_at as Date).toISOString() };
  });
}

/**
 * Owner-only: brings a retired Machine back. Only an explicit login on the
 * Machine asks for this; a daemon refreshing its credential never does, so a
 * removed Machine that wakes up stays removed. A Machine that is not retired,
 * or not the owner's, is left alone.
 */
export async function rejoinMachine(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string;
}): Promise<{ machineId: string; rejoined: boolean }> {
  return database.transaction({ requestId: input.requestId, operation: "machine.rejoin" }, async (tx) => {
    const rows = await tx.query<QueryResultRow>({ name: "machine_rejoin_v1", text: `UPDATE data.machines
      SET retired_at=NULL WHERE owner_user_id=$1 AND machine_id=$2 AND retired_at IS NOT NULL
      RETURNING machine_id`, values: [input.ownerUserId, input.machineId], maxRows: 1 });
    return { machineId: input.machineId, rejoined: Boolean(rows[0]) };
  });
}
