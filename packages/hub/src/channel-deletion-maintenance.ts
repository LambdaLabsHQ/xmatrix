import {
  channelPurgeObjects, purgeChannelRows, recordChannelPurgeObjects, retryBeforeCommit,
  type AuthorityDatabase, type DatabaseRequestContext, type DatabaseTransaction,
} from "@xmatrix/db";
import { createPostgresAuthorityFleet, type PostgresAuthorityFleetDependencies } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import type { Env } from "./types";

/**
 * One database-only step on a fresh session. A lost response before COMMIT
 * replays that step once; the stalled checkout is closed first. COMMIT
 * uncertainty and answered failures are left to the caller.
 */
function transactionBeforeCommit<T>(
  database: AuthorityDatabase,
  context: DatabaseRequestContext,
  run: (transaction: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return retryBeforeCommit(async () => {
    const session = database.openSession();
    try { return await session.transaction(context, run); }
    finally { await session.close(); }
  });
}

/** Each physical shard advances at most two exact jobs; placement fences exclude moving Spaces. */
export async function maintainChannelDeletions(env: Env, dependencies?: PostgresAuthorityFleetDependencies): Promise<void> {
  if (!env.RELAY_PAYLOAD_BUCKET) throw new Error("Channel purge storage is unavailable");
  const fleet = createPostgresAuthorityFleet(env, { applicationName: "xmatrix-channel-purge", ...POSTGRES_AUTHORITY_TIMEOUTS }, dependencies);
  const errors: unknown[] = [];
  for (const shard of fleet.physicalShards) {
    const session = shard.database.openSession();
    let jobs: readonly { space_id: string; channel_id: string; placement_epoch: number }[] = [];
    try {
      // Lock-free admission lookup. Hyperdrive can stall one round trip; the
      // single-read path retries that lost response once. A second timeout,
      // or any answered failure, still fails this pass. The session closes
      // before any purge step: a lost round trip makes it unusable, and a
      // later statement on it would report that instead of recovering.
      jobs = await session.transaction({
        requestId: crypto.randomUUID(), operation: "channel-purge.pending", statement: "single_read",
      },
        tx => tx.query<{ space_id: string; channel_id: string; placement_epoch: number }>({ name: "channel_purge_pending_v1",
          text: `SELECT d.space_id,d.channel_id,p.placement_epoch FROM data.channel_deletions d
            JOIN control.space_placement p ON p.space_id=d.space_id
            WHERE d.state='purging' AND p.state='active' AND p.target_shard_id IS NULL AND p.shard_id=$1
            ORDER BY d.updated_at,d.channel_id LIMIT 2`, values: [shard.shardId], maxRows: 2 }));
    } catch (error) { errors.push(error);
    } finally { await session.close(); }
    for (const job of jobs) {
      const placement = { spaceId: job.space_id, shardId: shard.shardId, placementEpoch: Number(job.placement_epoch) };
      try { await advanceChannelPurge(shard.database, env.RELAY_PAYLOAD_BUCKET,
        { ...placement, channelId: job.channel_id }); }
      catch (error) {
        errors.push(error);
        try {
          // A failed batch keeps its cursor, but yields its place to older
          // pending peers. Two poison jobs must not own both admission slots.
          // The bump is its own transaction, replayed once only when its
          // response was lost before COMMIT.
          await retryBeforeCommit(() => shard.database.transaction(
            { requestId: crypto.randomUUID(), operation: "channel-purge.retry", placement },
            tx => tx.query({ name: "channel_purge_retry_v1", text: `UPDATE data.channel_deletions
              SET updated_at=clock_timestamp() WHERE space_id=$1 AND channel_id=$2 AND state='purging'`,
              values: [job.space_id, job.channel_id], maxRows: 0 })));
        } catch (retryError) { errors.push(retryError); }
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, "Channel deletion maintenance requires retry");
}

export async function advanceChannelPurge(database: AuthorityDatabase, bucket: Pick<R2Bucket, "delete">, input: {
  spaceId: string; channelId: string; shardId: string; placementEpoch: number;
}): Promise<void> {
  const context = { requestId: crypto.randomUUID(), operation: "channel-purge.advance", placement: {
    spaceId: input.spaceId, shardId: input.shardId, placementEpoch: input.placementEpoch } };
  const objects = await transactionBeforeCommit(database, context,
    tx => channelPurgeObjects(tx, input.spaceId, input.channelId));
  if (objects) {
    // The cursor moves only after storage confirms deletion. Failed or interrupted calls retry the same keys.
    // Object deletion is outside the database; a lost COMMIT of the cursor update is not replayed here.
    if (objects.keys.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([bucket.delete(objects.keys), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Channel object deletion timed out")), 10_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    await transactionBeforeCommit(database, context,
      tx => recordChannelPurgeObjects(tx, { ...input, ...objects, at: new Date().toISOString() }));
  }
  await transactionBeforeCommit(database, context,
    tx => purgeChannelRows(tx, { ...input, at: new Date().toISOString() }));
}
