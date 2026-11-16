import type { SpaceBillingPolicy, StorageCategory } from "@xmatrix/billing";
import type { QueryResultRow } from "pg";

import type { DatabaseTransaction } from "./contracts.js";

/**
 * What a Space holds in private blobs (Channel attachments, Page media, private
 * records), metered in `data.space_storage_usage`. A Space holds a content
 * object while any of its refs names it; objects are immutable and shared, so a
 * second ref to held bytes changes nothing, and releasing the last one frees
 * them. Every change is recorded in the transaction that makes it and handed
 * to the billing policy, which is where a storage price applies.
 */
export const BLOB_STORAGE_CATEGORY: StorageCategory = "attachments";

type UsageRow = QueryResultRow & { logical_bytes: string | number; prior_bytes?: string | number };

/** Every object of the Space some ref names, counted from the content authority itself. */
const HELD_OBJECTS = `SELECT count(*) AS objects,COALESCE(sum(o.byte_length),0) AS bytes
  FROM data.content_objects o WHERE o.space_id=$1 AND EXISTS (SELECT 1 FROM data.content_refs r
    WHERE r.space_id=o.space_id AND r.child_object_id=o.object_id)`;

/**
 * Records that the Space now holds `objects` more (or fewer) objects of
 * `bytes`. The Space's first metered change counts everything it already
 * holds, this change included, so its row never starts from a guess.
 */
export async function meterBlobStorage(tx: DatabaseTransaction, billing: SpaceBillingPolicy, input: {
  spaceId: string; objects: number; bytes: number; now: string;
}): Promise<void> {
  const change = () => tx.query<UsageRow>({
    name: "storage_usage_meter_v1",
    text: `UPDATE data.space_storage_usage SET logical_rows=logical_rows+$3,
        logical_bytes=logical_bytes+$4,version=version+1,updated_at=$5
      WHERE space_id=$1 AND category=$2 RETURNING logical_bytes`,
    values: [input.spaceId, BLOB_STORAGE_CATEGORY, input.objects, input.bytes, input.now], maxRows: 1,
  });
  let rows = await change();
  if (!rows[0]) {
    rows = await tx.query<UsageRow>({
      name: "storage_usage_open_v1",
      text: `INSERT INTO data.space_storage_usage
          (space_id,category,logical_rows,logical_bytes,version,updated_at)
        SELECT $1,$2,held.objects,held.bytes,1,$3 FROM (${HELD_OBJECTS}) held
        ON CONFLICT (space_id,category) DO NOTHING RETURNING logical_bytes`,
      values: [input.spaceId, BLOB_STORAGE_CATEGORY, input.now], maxRows: 1,
    });
    // A concurrent first change opened the row before this one could see it.
    if (!rows[0]) rows = await change();
  }
  await billing.storageChanged(tx, { spaceId: input.spaceId, now: input.now, category: BLOB_STORAGE_CATEGORY,
    deltaBytes: input.bytes, totalBytes: Number(rows[0]!.logical_bytes) });
}

/**
 * Counts what the Space holds again, after a bulk purge removed refs without
 * metering each one (a deleted Channel's). A Space never metered has no row
 * to correct: its first change counts it.
 */
export async function recountBlobStorage(tx: DatabaseTransaction, billing: SpaceBillingPolicy, input: {
  spaceId: string; now: string;
}): Promise<void> {
  // The joined `prior` row is read before this statement's update.
  const rows = await tx.query<UsageRow>({
    name: "storage_usage_recount_v1",
    text: `UPDATE data.space_storage_usage usage SET logical_rows=held.objects,logical_bytes=held.bytes,
        version=usage.version+1,updated_at=$3
      FROM (${HELD_OBJECTS}) held, data.space_storage_usage prior
      WHERE usage.space_id=$1 AND usage.category=$2 AND prior.space_id=usage.space_id
        AND prior.category=usage.category
      RETURNING usage.logical_bytes,prior.logical_bytes AS prior_bytes`,
    values: [input.spaceId, BLOB_STORAGE_CATEGORY, input.now], maxRows: 1,
  });
  const row = rows[0];
  if (!row) return;
  const deltaBytes = Number(row.logical_bytes) - Number(row.prior_bytes);
  if (deltaBytes !== 0) await billing.storageChanged(tx, { spaceId: input.spaceId, now: input.now,
    category: BLOB_STORAGE_CATEGORY, deltaBytes, totalBytes: Number(row.logical_bytes) });
}
