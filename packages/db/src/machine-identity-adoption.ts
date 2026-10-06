import type { QueryResultRow } from "pg";

import type { AuthorityDatabase, DatabaseTransaction } from "./contracts.js";
import { ControlError } from "./control-error.js";

/** The only Machine id shape a current CLI derives: `machine:` + SHA-256 hex. */
const DERIVED_MACHINE_ID = /^machine:[0-9a-f]{64}$/u;
const MAX_LEGACY_IDS = 8;

export class MachineIdentityAdoptionError extends ControlError {
  override name = "MachineIdentityAdoptionError";
  declare readonly code: "invalid_machine_identity" | "machine_identity_adoption_conflict" | "machine_not_found";
  constructor(code: "invalid_machine_identity" | "machine_identity_adoption_conflict" | "machine_not_found", status: number, message: string) {
    super(code, status, message);
  }
}

// Stored per-owner or per-Machine; their text may spell a legacy id inside a
// key (workspace_id is `["<machineId>","<cwd>"]`) or inside JSON.
const IDENTITY_COLUMNS = ["machine_id", "workspace_machine_id", "workspace_id"];
// Handled explicitly: the name row, and daemon rows whose key is a hash of the id.
const EXCLUDED_TABLES = new Set(["data.machines", "data.machine_daemons", "data.machine_daemon_activations",
  "data.machine_daemon_control_audit", "control.machine_identity_adoptions"]);

interface TableShape {
  name: string;
  columns: Array<{ name: string; type: string; generated: boolean }>;
  key: string[];
}

type Counts = Record<string, { copied: number; updated: number; removed: number }>;

function quote(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

function table(name: string): string {
  const [schema, relation] = name.split(".");
  return `${quote(schema!)}.${quote(relation!)}`;
}

/** Text-bearing columns get the id replaced; every other type is copied as is. */
function rewritten(column: TableShape["columns"][number]): string {
  const value = `t.${quote(column.name)}`;
  if (column.type === "text" || column.type.startsWith("character varying")) return `replace(${value},$2,$3)`;
  if (column.type === "jsonb" || column.type === "json") return `replace(${value}::text,$2,$3)::${column.type}`;
  if (column.type === "text[]") return `COALESCE((SELECT array_agg(replace(item,$2,$3) ORDER BY position)
    FROM unnest(${value}) WITH ORDINALITY AS entry(item,position)),${value})`;
  return value;
}

function textual(column: TableShape["columns"][number]): boolean {
  return rewritten(column) !== `t.${quote(column.name)}`;
}

async function catalog(tx: DatabaseTransaction): Promise<TableShape[]> {
  const rows = await tx.query<QueryResultRow>({ name: "machine_adoption_catalog_v2", text: `SELECT
    format('%s.%s', namespace.nspname, relation.relname) AS name,
    (SELECT json_agg(json_build_object('name', attribute.attname,
        'type', format_type(attribute.atttypid, attribute.atttypmod), 'generated', attribute.attgenerated <> '')
      ORDER BY attribute.attnum) FROM pg_attribute attribute
      WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped) AS columns,
    COALESCE((SELECT json_agg(attribute.attname ORDER BY attribute.attnum) FROM pg_index index
      JOIN pg_attribute attribute ON attribute.attrelid=index.indrelid AND attribute.attnum=ANY(index.indkey)
      WHERE index.indrelid=relation.oid AND index.indisprimary), '[]'::json) AS key
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE relation.relkind IN ('r','p') AND namespace.nspname IN ('data','control')
      AND EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid AND attribute.attnum>0
          AND NOT attribute.attisdropped AND attribute.attname = ANY($1::text[]))
    ORDER BY 1`, values: [IDENTITY_COLUMNS], maxRows: 200 });
  const edges = await tx.query<QueryResultRow>({ name: "machine_adoption_references_v1", text: `SELECT
    format('%s.%s', child_namespace.nspname, child.relname) AS child,
    format('%s.%s', parent_namespace.nspname, parent.relname) AS parent
    FROM pg_constraint reference
    JOIN pg_class child ON child.oid=reference.conrelid JOIN pg_namespace child_namespace ON child_namespace.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=reference.confrelid JOIN pg_namespace parent_namespace ON parent_namespace.oid=parent.relnamespace
    WHERE reference.contype='f' AND child_namespace.nspname IN ('data','control')`, values: [], maxRows: 1_000 });
  const shapes = rows.filter(row => !EXCLUDED_TABLES.has(String(row.name))).map(row => ({
    name: String(row.name), columns: row.columns as TableShape["columns"], key: row.key as string[] }));
  // Parents before children, so a rewritten child always finds its rewritten parent.
  const ordered: TableShape[] = [];
  const visiting = new Set<string>();
  const visit = (shape: TableShape) => {
    if (ordered.includes(shape) || visiting.has(shape.name)) return;
    visiting.add(shape.name);
    for (const edge of edges) if (edge.child === shape.name && edge.parent !== shape.name) {
      const parent = shapes.find(candidate => candidate.name === edge.parent);
      if (parent) visit(parent);
    }
    ordered.push(shape);
  };
  for (const shape of shapes) visit(shape);
  return ordered;
}

function scope(shape: TableShape): string | undefined {
  const names = new Set(shape.columns.map(column => column.name));
  if (names.has("owner_user_id")) return "t.owner_user_id=$1";
  // A legacy id is a random UUID: without an owner column the id alone scopes it.
  if (names.has("machine_id")) return "t.machine_id=$2 AND $1::text IS NOT NULL";
  return undefined;
}

function keyContains(shape: TableShape): string {
  return `strpos(concat_ws(chr(31), ${shape.key.map(name => `t.${quote(name)}::text`).join(", ")}), $2)>0`;
}

/**
 * Rewrites one legacy Machine id to its host-derived id everywhere the owner's
 * records spell it. A row whose key spells it is copied under the new key and
 * the original removed; an existing row under the new key wins, which is how
 * several legacy ids of one host merge into one Machine. Every other row is
 * rewritten in place. Anything the rewrite cannot satisfy (a foreign key into a
 * table outside this set, a check) aborts the whole adoption.
 */
async function rewrite(tx: DatabaseTransaction, input: {
  ownerUserId: string; legacyMachineId: string; machineId: string;
  daemonId: (ownerUserId: string, machineId: string, hostId: string) => string;
}): Promise<Counts> {
  const counts: Counts = {};
  const values = [input.ownerUserId, input.legacyMachineId, input.machineId];
  const machine = await tx.query<QueryResultRow>({ name: "machine_adoption_name_v1", text: `SELECT machine_id
    FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2`, values: [input.ownerUserId, input.machineId], maxRows: 1 });
  if (machine[0]) {
    await tx.query({ name: "machine_adoption_name_drop_v1", text: `DELETE FROM data.machines
      WHERE owner_user_id=$1 AND machine_id=$2`, values: [input.ownerUserId, input.legacyMachineId], maxRows: 0 });
  } else {
    await tx.query({ name: "machine_adoption_name_move_v1", text: `UPDATE data.machines SET machine_id=$3
      WHERE owner_user_id=$1 AND machine_id=$2`, values, maxRows: 0 });
  }
  const daemons = await tx.query<QueryResultRow>({ name: "machine_adoption_daemons_v1", text: `SELECT daemon_id,hostname
    FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2 ORDER BY daemon_id FOR UPDATE`,
  values: [input.ownerUserId, input.legacyMachineId], maxRows: 100 });
  for (const row of daemons) {
    const legacyDaemonId = String(row.daemon_id), hostId = String(row.hostname ?? "");
    const daemonId = input.daemonId(input.ownerUserId, input.machineId, hostId);
    // A derived Machine has one daemon whatever its host, so several legacy
    // daemons (one per old host name) fold into the first one moved.
    const current = await tx.query<QueryResultRow>({ name: "machine_adoption_daemon_current_v2", text: `SELECT 1
      FROM data.machine_daemons WHERE daemon_id=$1`, values: [daemonId], maxRows: 1 });
    if (current[0]) {
      // The Machine already has its derived daemon; the legacy daemon is a stale connection record.
      await tx.query({ name: "machine_adoption_daemon_activation_drop_v1", text: `DELETE FROM
        data.machine_daemon_activations WHERE daemon_id=$1`, values: [legacyDaemonId], maxRows: 0 });
      await tx.query({ name: "machine_adoption_daemon_drop_v1", text: `DELETE FROM data.machine_daemons
        WHERE daemon_id=$1`, values: [legacyDaemonId], maxRows: 0 });
      continue;
    }
    await tx.query({ name: "machine_adoption_daemon_move_v1", text: `UPDATE data.machine_daemons
      SET machine_id=$2,daemon_id=$3,metadata_json=replace(metadata_json::text,$1,$2)::jsonb
      WHERE daemon_id=$4`, values: [input.legacyMachineId, input.machineId, daemonId, legacyDaemonId], maxRows: 0 });
    await tx.query({ name: "machine_adoption_daemon_activation_move_v1", text: `UPDATE data.machine_daemon_activations
      SET daemon_id=$2 WHERE daemon_id=$1`, values: [legacyDaemonId, daemonId], maxRows: 0 });
    await tx.query({ name: "machine_adoption_daemon_allocation_move_v1", text: `UPDATE
      control.registration_execution_allocations SET daemon_id=$2 WHERE daemon_id=$1`,
    values: [legacyDaemonId, daemonId], maxRows: 0 });
  }

  const shapes = (await catalog(tx)).filter(shape => scope(shape));
  for (const shape of shapes) {
    counts[shape.name] = { copied: 0, updated: 0, removed: 0 };
    if (!shape.key.length) continue;
    const columns = shape.columns.filter(column => !column.generated);
    const copied = await tx.query<QueryResultRow>({ name: `machine_adoption_copy_${shape.name}`, text: `WITH copied AS (
      INSERT INTO ${table(shape.name)} (${columns.map(column => quote(column.name)).join(",")})
      OVERRIDING SYSTEM VALUE SELECT ${columns.map(rewritten).join(",")} FROM ${table(shape.name)} t
      WHERE ${scope(shape)} AND ${keyContains(shape)} ON CONFLICT DO NOTHING RETURNING 1)
      SELECT count(*)::int AS count FROM copied`, values, maxRows: 1 });
    counts[shape.name]!.copied = Number(copied[0]?.count ?? 0);
  }
  for (const shape of shapes) {
    const columns = shape.columns.filter(column => !column.generated && textual(column));
    if (!columns.length) continue;
    const updated = await tx.query<QueryResultRow>({ name: `machine_adoption_update_${shape.name}`, text: `WITH updated AS (
      UPDATE ${table(shape.name)} t SET ${columns.map(column => `${quote(column.name)}=${rewritten(column)}`).join(",")}
      WHERE ${scope(shape)} AND strpos(t::text,$2)>0${shape.key.length ? ` AND NOT ${keyContains(shape)}` : ""}
      RETURNING 1) SELECT count(*)::int AS count FROM updated`, values, maxRows: 1 });
    counts[shape.name]!.updated = Number(updated[0]?.count ?? 0);
  }
  for (const shape of [...shapes].reverse()) {
    if (!shape.key.length) continue;
    const removed = await tx.query<QueryResultRow>({ name: `machine_adoption_remove_${shape.name}`, text: `WITH removed AS (
      DELETE FROM ${table(shape.name)} t WHERE ${scope(shape)} AND ${keyContains(shape)} RETURNING 1)
      SELECT count(*)::int AS count FROM removed`, values: values.slice(0, 2), maxRows: 1 });
    counts[shape.name]!.removed = Number(removed[0]?.count ?? 0);
  }
  for (const [name, count] of Object.entries(counts)) {
    if (!count.copied && !count.updated && !count.removed) delete counts[name];
  }
  return counts;
}

/**
 * Adopts the legacy minted ids an updated CLI reports into its host-derived
 * Machine id. Idempotent per legacy id; one transaction for the whole set.
 */
export async function adoptLegacyMachineIds(database: AuthorityDatabase, input: {
  requestId: string; ownerUserId: string; machineId: string; legacyMachineIds: unknown;
  daemonId: (ownerUserId: string, machineId: string, hostId: string) => string;
}): Promise<{ machineId: string; adopted: string[]; reused: string[] }> {
  if (!DERIVED_MACHINE_ID.test(input.machineId)) throw new MachineIdentityAdoptionError(
    "invalid_machine_identity", 400, "A Machine id must be derived from its host");
  const legacy = Array.isArray(input.legacyMachineIds) ? input.legacyMachineIds : [];
  if (legacy.length > MAX_LEGACY_IDS || legacy.some(id => typeof id !== "string" || !id.startsWith("machine:") ||
      id.length > 160 || DERIVED_MACHINE_ID.test(id) || /\p{Cc}/u.test(id))) throw new MachineIdentityAdoptionError(
    "invalid_machine_identity", 400, "Legacy Machine ids are invalid");
  const ids = [...new Set(legacy as string[])];
  return database.transaction({ requestId: input.requestId, operation: "machine.adopt-identity" }, async (tx) => {
    await tx.query({ name: "machine_adoption_owner_lock_v1", text: `SELECT
      pg_advisory_xact_lock(hashtextextended('machine-adoption:'||$1,0))`, values: [input.ownerUserId], maxRows: 1 });
    const adopted: string[] = [], reused: string[] = [];
    for (const legacyMachineId of ids) {
      const prior = await tx.query<QueryResultRow>({ name: "machine_adoption_prior_v1", text: `SELECT machine_id
        FROM control.machine_identity_adoptions WHERE owner_user_id=$1 AND legacy_machine_id=$2`,
      values: [input.ownerUserId, legacyMachineId], maxRows: 1 });
      if (prior[0]) {
        if (prior[0].machine_id !== input.machineId) throw new MachineIdentityAdoptionError(
          "machine_identity_adoption_conflict", 409, "This legacy Machine id was already adopted by another Machine");
        reused.push(legacyMachineId);
        continue;
      }
      const owned = await tx.query<QueryResultRow>({ name: "machine_adoption_owned_v1", text: `SELECT 1 WHERE
        EXISTS (SELECT 1 FROM data.machines WHERE owner_user_id=$1 AND machine_id=$2)
        OR EXISTS (SELECT 1 FROM data.machine_daemons WHERE owner_user_id=$1 AND machine_id=$2)
        OR EXISTS (SELECT 1 FROM data.workspaces WHERE owner_user_id=$1 AND machine_id=$2)`,
      values: [input.ownerUserId, legacyMachineId], maxRows: 1 });
      // Nothing of this owner spells it: there is nothing to adopt, and an id
      // the owner never used must not reach tables that carry no owner.
      if (!owned[0]) continue;
      const counts = await rewrite(tx, { ownerUserId: input.ownerUserId, legacyMachineId,
        machineId: input.machineId, daemonId: input.daemonId });
      await tx.query({ name: "machine_adoption_record_v1", text: `INSERT INTO control.machine_identity_adoptions
        (owner_user_id,legacy_machine_id,machine_id,rewritten_json) VALUES ($1,$2,$3,$4::jsonb)`,
      values: [input.ownerUserId, legacyMachineId, input.machineId, JSON.stringify(counts)], maxRows: 0 });
      adopted.push(legacyMachineId);
    }
    return { machineId: input.machineId, adopted, reused };
  });
}
