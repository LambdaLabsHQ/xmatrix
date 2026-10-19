import { channelPurgeObjects, purgeChannelRows, recordChannelPurgeObjects, type AuthorityDatabase } from "@xmatrix/db";
import { createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import type { Env } from "./types";

/** Each physical shard advances at most two exact jobs; placement fences exclude moving Spaces. */
export async function maintainChannelDeletions(env: Env): Promise<void> {
  if (!env.RELAY_PAYLOAD_BUCKET) throw new Error("Channel purge storage is unavailable");
  const fleet = createPostgresAuthorityFleet(env, { applicationName: "xmatrix-channel-purge", ...POSTGRES_AUTHORITY_TIMEOUTS });
  const errors: unknown[] = [];
  for (const shard of fleet.physicalShards) {
    const session = shard.database.openSession();
    try {
      const jobs = await session.transaction({ requestId: crypto.randomUUID(), operation: "channel-purge.pending" },
        tx => tx.query<{ space_id: string; channel_id: string; placement_epoch: number }>({ name: "channel_purge_pending_v1",
          text: `SELECT d.space_id,d.channel_id,p.placement_epoch FROM data.channel_deletions d
            JOIN control.space_placement p ON p.space_id=d.space_id
            WHERE d.state='purging' AND p.state='active' AND p.target_shard_id IS NULL AND p.shard_id=$1
            ORDER BY d.updated_at,d.channel_id LIMIT 2`, values: [shard.shardId], maxRows: 2 }));
      for (const job of jobs) {
        try { await advanceChannelPurge(session, env.RELAY_PAYLOAD_BUCKET,
          { spaceId: job.space_id, channelId: job.channel_id, shardId: shard.shardId, placementEpoch: Number(job.placement_epoch) }); }
        catch (error) { errors.push(error); }
      }
    } catch (error) { errors.push(error);
    } finally { await session.close(); }
  }
  if (errors.length) throw new AggregateError(errors, "Channel deletion maintenance requires retry");
}

export async function advanceChannelPurge(database: AuthorityDatabase, bucket: Pick<R2Bucket, "delete">, input: {
  spaceId: string; channelId: string; shardId: string; placementEpoch: number;
}): Promise<void> {
  const context = { requestId: crypto.randomUUID(), operation: "channel-purge.advance", placement: {
    spaceId: input.spaceId, shardId: input.shardId, placementEpoch: input.placementEpoch } };
  const objects = await database.transaction(context, tx => channelPurgeObjects(tx, input.spaceId, input.channelId));
  if (objects) {
    // The cursor moves only after storage confirms deletion. Failed or interrupted calls retry the same keys.
    if (objects.keys.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([bucket.delete(objects.keys), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Channel object deletion timed out")), 10_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    await database.transaction(context, tx => recordChannelPurgeObjects(tx, { ...input, ...objects, at: new Date().toISOString() }));
  }
  await database.transaction(context, tx => purgeChannelRows(tx, { ...input, at: new Date().toISOString() }));
}
