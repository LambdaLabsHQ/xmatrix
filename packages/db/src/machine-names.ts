import type { QueryResultRow } from "pg";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { ControlError } from "./control-error.js";

/** A Machine's name is owner-unique data; renaming it changes no key. */
export class MachineNameError extends ControlError {
  override name = "MachineNameError";
  declare readonly code: "invalid_machine_name" | "machine_name_taken" | "machine_not_found" | "invalid_machine_identity" | "machine_name_required" | "invalid_machine_auto_assign";
  constructor(code: "invalid_machine_name" | "machine_name_taken" | "machine_not_found" | "invalid_machine_identity" | "machine_name_required" | "invalid_machine_auto_assign", status: number, message: string) {
    super(code, status, message);
  }
}

const MAX_NAME_LENGTH = 64;
// Leaves room for a "-NN" collision suffix inside the column bound.
const MAX_BASE_LENGTH = 56;
const MAX_SUFFIX = 99;

/** The accepted spelling of a name, or undefined when it cannot be one. */
function normalizeMachineName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || [...name].length > MAX_NAME_LENGTH || /\p{Cc}/u.test(name)) return undefined;
  return name;
}

async function lockMachineNames(tx: DatabaseTransaction, ownerUserId: string): Promise<void> {
  await tx.query({ name: "machine_names_owner_lock_v1", text:
    "SELECT pg_advisory_xact_lock(hashtextextended('machine-names:'||$1,0))",
  values: [ownerUserId], maxRows: 1 });
}

/** A chosen name is a Machine authority fact, never a hostname default.
 * The read does not take the owner name lock. Enroll, connect, and recovery
 * run inside the daemon command transaction; holding that lock until commit
 * makes the owner's other Machines fail with lock_timeout. */
export async function requireMachineName(tx: DatabaseTransaction, input: {
  ownerUserId: string; machineId: string;
}): Promise<void> {
  const rows = await tx.query<QueryResultRow>({ name: "machine_name_require_v1", text: `SELECT name
    FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2`,
  values: [input.ownerUserId, input.machineId], maxRows: 1 });
  if (!normalizeMachineName(rows[0]?.name)) throw new MachineNameError("machine_name_required", 409,
    "Name this Machine in xMatrix setup before starting its daemon");
}

function observedParentMachineId(parentMachineId: unknown, machineId: string): string | undefined {
  return typeof parentMachineId === "string" && /^machine:[0-9a-f]{64}$/u.test(parentMachineId)
    && parentMachineId !== machineId ? parentMachineId : undefined;
}

async function observeParentMachine(tx: DatabaseTransaction, input: {
  ownerUserId: string; machineId: string;
}, parent: string | undefined): Promise<void> {
  if (!parent) return;
  await tx.query({ name: "machine_parent_observe_v1", text: `UPDATE data.machines SET parent_machine_id=$3
    WHERE owner_user_id=$1 AND machine_id=$2 AND parent_machine_id IS DISTINCT FROM $3`,
  values: [input.ownerUserId, input.machineId, parent], maxRows: 0 });
}

/**
 * Gives a Machine seen for the first time the host name it reported, with the
 * owner's first free `-N` suffix on a collision. An already named Machine keeps
 * its name: a later host name change is only a daemon observation, and it does
 * not take the owner name lock. A concurrent first sighting inserts nothing
 * here and the other one wins.
 */
export async function ensureMachineName(tx: DatabaseTransaction, input: {
  ownerUserId: string; machineId: string; hostName?: string | null; hostId: string; parentMachineId?: unknown;
}): Promise<void> {
  const parent = observedParentMachineId(input.parentMachineId, input.machineId);
  const existing = await tx.query<QueryResultRow>({ name: "machine_name_existing_v1", text: `SELECT 1
    FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2`,
  values: [input.ownerUserId, input.machineId], maxRows: 1 });
  if (existing[0]) {
    await observeParentMachine(tx, input, parent);
    return;
  }
  await lockMachineNames(tx, input.ownerUserId);
  const reported = [...(input.hostName ?? "").replace(/\p{Cc}/gu, "").trim() ||
    input.hostId.replace(/\p{Cc}/gu, "").trim() || "machine"];
  const base = reported.slice(0, MAX_BASE_LENGTH).join("").trim() || "machine";
  await tx.query({ name: "machine_name_assign_v1", text: `INSERT INTO data.machines (owner_user_id,machine_id,name)
    SELECT $1,$2,candidate.name FROM (
      SELECT CASE WHEN suffix=1 THEN $3::text ELSE $3::text||'-'||suffix END AS name, suffix
      FROM generate_series(1,$4::int) AS suffix) candidate
    WHERE NOT EXISTS (SELECT 1 FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2)
      AND NOT EXISTS (SELECT 1 FROM data.machines WHERE owner_user_id=$1 AND lower(name)=lower(candidate.name))
    ORDER BY candidate.suffix LIMIT 1
    ON CONFLICT DO NOTHING`,
  values: [input.ownerUserId, input.machineId, base, MAX_SUFFIX], maxRows: 0 });
  await observeParentMachine(tx, input, parent);
}

/** Owner-only: renames one of the owner's Machines. */
export async function renameMachine(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string; name: unknown;
}): Promise<{ machineId: string; name: string }> {
  return writeMachineName(database, input, false);
}

/** Explicit owner naming before enrollment; creates only a derived Machine identity. */
export async function nameMachine(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string; name: unknown;
}): Promise<{ machineId: string; name: string }> {
  if (!/^machine:[0-9a-f]{64}$/u.test(input.machineId)) {
    throw new MachineNameError("invalid_machine_identity", 400, "A new Machine requires a derived identity");
  }
  return writeMachineName(database, input, true);
}

async function writeMachineName(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string; name: unknown;
}, create: boolean): Promise<{ machineId: string; name: string }> {
  const name = normalizeMachineName(input.name);
  if (!name) throw new MachineNameError("invalid_machine_name", 400,
    `A Machine name is 1-${MAX_NAME_LENGTH} characters without control characters`);
  return database.transaction({ requestId: input.requestId, operation: create ? "machine.name" : "machine.rename" }, async (tx) => {
    await lockMachineNames(tx, input.ownerUserId);
    const taken = await tx.query<QueryResultRow>({ name: "machine_rename_taken_v1", text: `SELECT machine_id
      FROM data.machines WHERE owner_user_id=$1 AND lower(name)=lower($2) AND machine_id<>$3`,
    values: [input.ownerUserId, name, input.machineId], maxRows: 1 });
    if (taken[0]) throw new MachineNameError("machine_name_taken", 409,
      `Another of your Machines is already named ${name}`);
    const rows = create ? await tx.query<QueryResultRow>({ name: "machine_name_set_v1", text: `INSERT INTO data.machines
      (owner_user_id,machine_id,name) VALUES ($1,$2,$3)
      ON CONFLICT (owner_user_id,machine_id) DO UPDATE SET name=EXCLUDED.name,
        renamed_at=CASE WHEN data.machines.name IS DISTINCT FROM EXCLUDED.name
          THEN clock_timestamp() ELSE data.machines.renamed_at END RETURNING name`,
    values: [input.ownerUserId, input.machineId, name], maxRows: 1 }) : await tx.query<QueryResultRow>({ name: "machine_rename_v1", text: `UPDATE data.machines
      SET name=$3, renamed_at=clock_timestamp() WHERE owner_user_id=$1 AND machine_id=$2 RETURNING name`,
    values: [input.ownerUserId, input.machineId, name], maxRows: 1 });
    if (!rows[0]) throw new MachineNameError("machine_not_found", 404, "Machine not found");
    return { machineId: input.machineId, name: String(rows[0].name) };
  });
}

/** Missing means not yet named; another owner's Machine never supplies a name. */
export async function getMachineName(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string;
}): Promise<{ machineId: string; name: string | null }> {
  return database.transaction({ requestId: input.requestId, operation: "machine.get-name" }, async (tx) => {
    const rows = await tx.query<QueryResultRow>({ name: "machine_name_get_v1", text: `SELECT name
      FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2`,
    values: [input.ownerUserId, input.machineId], maxRows: 1 });
    return { machineId: input.machineId, name: rows[0] ? String(rows[0].name) : null };
  });
}

/** Owner-only: whether automatic assignment may place work on one of the
 * owner's Machines. Off, only a launch that names the Machine runs there. */
export async function setMachineAutoAssign(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string; autoAssign: unknown;
}): Promise<{ machineId: string; autoAssign: boolean }> {
  if (typeof input.autoAssign !== "boolean") throw new MachineNameError("invalid_machine_auto_assign", 400,
    "autoAssign must be true or false");
  return database.transaction({ requestId: input.requestId, operation: "machine.auto-assign" }, async (tx) => {
    const rows = await tx.query<QueryResultRow>({ name: "machine_auto_assign_set_v1", text: `UPDATE data.machines
      SET auto_assign=$3 WHERE owner_user_id=$1 AND machine_id=$2 AND retired_at IS NULL RETURNING auto_assign`,
    values: [input.ownerUserId, input.machineId, input.autoAssign], maxRows: 1 });
    if (!rows[0]) throw new MachineNameError("machine_not_found", 404, "Machine not found");
    return { machineId: input.machineId, autoAssign: rows[0].auto_assign !== false };
  });
}
