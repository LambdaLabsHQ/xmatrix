import { naturalInstanceId, naturalRunId, parseNaturalInstanceId } from "@xmatrix/protocol";

import type { DatabaseTransaction } from "./contracts.js";

/**
 * Instance and Run ids are their natural keys
 * (docs/architecture/instance-run-natural-keys.md). A creation path reserves
 * the key under its own idempotency key first, so a replay receives the same
 * ids, then writes rows under those ids.
 */

export type NaturalKeyScope = "instance" | "run" | "about";

export interface NaturalKeyReservation {
  channelId: string;
  channelInstanceId: number | null;
  runOrdinal: number;
  instanceId: string | null;
  runId: string;
}

export class NaturalKeyError extends Error {
  constructor(readonly code: "natural_key_mismatch" | "natural_key_instance_missing" | "natural_key_too_long") {
    super(code);
  }
}

const MAX_ID_LENGTH = 300;
// Historical backfill ordinals are addresses, not a spawn counter.
const LEGACY_ORDINAL_BASE = "8000000000000000";

async function bump(tx: DatabaseTransaction, channelId: string, scope: string, count: number,
  floorSql: string): Promise<number> {
  const name = scope === "instance" || scope === "about" ? scope : "run";
  const rows = await tx.query<{ last_value: string | number }>({ name: `natural_key_counter_bump_${name}_v1`,
    text: `INSERT INTO data.natural_key_counters AS counter (channel_id,scope,last_value)
      VALUES ($1,$2,COALESCE((${floorSql}),0)+$3)
      ON CONFLICT (channel_id,scope) DO UPDATE
        SET last_value=GREATEST(counter.last_value,COALESCE((${floorSql}),0))+$3
      RETURNING counter.last_value`,
    values: [channelId, scope, count], maxRows: 1 });
  return Number(rows[0]!.last_value) - count + 1;
}

/**
 * Allocates `count` consecutive Instance ordinals and returns the first. The
 * counter row lock serializes allocators; the live maximum keeps ordinals
 * written before the counter existed out of the range.
 */
export function allocateInstanceOrdinals(tx: DatabaseTransaction, channelId: string, count: number): Promise<number> {
  return bump(tx, channelId, "instance", count, `SELECT MAX(instance.channel_instance_id) FROM data.instances instance
    WHERE instance.channel_id=$1 AND instance.channel_instance_id<${LEGACY_ORDINAL_BASE}`);
}

/** The ordinal a natural Instance id carries for this Channel, or null for any other id. */
export function naturalInstanceOrdinal(channelId: string, instanceId: string): number | null {
  const key = parseNaturalInstanceId(instanceId);
  return key && key.channelId === channelId ? Number(key.channelInstanceId) : null;
}

/** The ordinal an Instance row is written with: its natural id's, or a fresh allocation. */
export async function instanceOrdinalFor(tx: DatabaseTransaction, channelId: string, instanceId: string): Promise<number> {
  return naturalInstanceOrdinal(channelId, instanceId) ?? allocateInstanceOrdinals(tx, channelId, 1);
}

/**
 * Reserves the key for one creation. `instance` starts a new Instance at run 1;
 * `run` starts the next Run of an existing Instance; `about` starts the next
 * Channel About Run. Replaying a creation key returns its first reservation
 * and refuses a different Channel, scope or Instance.
 */
export async function reserveNaturalKey(tx: DatabaseTransaction, input: {
  creationKey: string; channelId: string; scope: NaturalKeyScope; channelInstanceId?: number; at: string;
}): Promise<NaturalKeyReservation> {
  await tx.query({ name: "natural_key_reservation_lock_v1", text: `SELECT pg_advisory_xact_lock(
    hashtextextended('natural-key:'||$1,0))`, values: [input.creationKey], maxRows: 1 });
  const prior = (await tx.query<{ channel_id: string; channel_instance_id: string | null; run_ordinal: string }>({
    name: "natural_key_reservation_existing_v1", text: `SELECT channel_id,channel_instance_id,run_ordinal
      FROM data.natural_key_reservations WHERE creation_key=$1`, values: [input.creationKey], maxRows: 1 }))[0];
  if (prior) {
    const reservation = keyed(prior.channel_id, prior.channel_instance_id === null ? null : Number(prior.channel_instance_id),
      Number(prior.run_ordinal));
    const expectedInstance = input.scope === "about" ? null
      : input.scope === "run" ? input.channelInstanceId ?? null : reservation.channelInstanceId;
    if (reservation.channelId !== input.channelId || reservation.channelInstanceId !== expectedInstance ||
        (input.scope === "instance" && reservation.runOrdinal !== 1)) throw new NaturalKeyError("natural_key_mismatch");
    return reservation;
  }
  let channelInstanceId: number | null = null;
  let runOrdinal = 1;
  if (input.scope === "instance") {
    channelInstanceId = await allocateInstanceOrdinals(tx, input.channelId, 1);
  } else if (input.scope === "about") {
    runOrdinal = await bump(tx, input.channelId, "about", 1, "SELECT NULL::bigint");
  } else {
    channelInstanceId = input.channelInstanceId ?? 0;
    const exists = await tx.query({ name: "natural_key_reservation_instance_v1", text: `SELECT 1 FROM data.instances
      WHERE channel_id=$1 AND channel_instance_id=$2`, values: [input.channelId, channelInstanceId], maxRows: 1 });
    if (!exists[0]) throw new NaturalKeyError("natural_key_instance_missing");
    // An Instance that predates its counter is on its first Run.
    runOrdinal = await bump(tx, input.channelId, `run:${channelInstanceId}`, 1, "SELECT 1::bigint");
  }
  const reservation = keyed(input.channelId, channelInstanceId, runOrdinal);
  await tx.query({ name: "natural_key_reservation_insert_v1", text: `INSERT INTO data.natural_key_reservations
    (creation_key,channel_id,channel_instance_id,run_ordinal,created_at) VALUES ($1,$2,$3,$4,$5)`,
  values: [input.creationKey, input.channelId, channelInstanceId, runOrdinal, input.at], maxRows: 0 });
  return reservation;
}

function keyed(channelId: string, channelInstanceId: number | null, runOrdinal: number): NaturalKeyReservation {
  const instanceId = channelInstanceId === null ? null
    : naturalInstanceId({ channelId, channelInstanceId: String(channelInstanceId) });
  const runId = channelInstanceId === null
    ? naturalRunId({ channelId, about: true, runOrdinal: String(runOrdinal) })
    : naturalRunId({ channelId, channelInstanceId: String(channelInstanceId), runOrdinal: String(runOrdinal) });
  if (runId.length > MAX_ID_LENGTH) throw new NaturalKeyError("natural_key_too_long");
  return { channelId, channelInstanceId, runOrdinal, instanceId, runId };
}
