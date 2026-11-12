import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAuthorityDatabase, PostgresBillingRepository, PostgresGooglePlayBillingRepository } from "../dist/index.js";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

integration("a Google Play purchase token binds once, bills one seat and ends at Google's expiry", async () => {
  const f = await isolatedPostgres("google_play_billing", { shard: true });
  const db = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const billing = new PostgresBillingRepository(db, "shard-0");
  const play = new PostgresGooglePlayBillingRepository(db, billing);
  try {
    for (const space of ["play-a", "play-b"]) {
      await f.run(`INSERT INTO control.space_placement
        (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
        VALUES ($1,'shard-0',1,'active','test',now(),now())`, [space]);
      await f.run(`INSERT INTO data.spaces
        (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
        VALUES ($1,'play-owner',$1,$1,1,'{}',now(),now())`, [space]);
      await f.run("INSERT INTO data.space_control_heads VALUES ($1,0,now())", [space]);
      await f.run(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
        VALUES ($1,'play-owner','owner',1,now(),now())`, [space]);
    }
    const prepare = (spaceId, actorUserId = "play-owner") => play.prepare({
      requestId: randomUUID(), commandId: randomUUID(), actorUserId, spaceId, interval: "month", productId: "monthly" });
    await assert.rejects(prepare("play-a", "outsider"));
    const [a, b] = await Promise.all([prepare("play-a"), prepare("play-b")]);
    assert.notEqual(a.accountToken, b.accountToken);
    assert.equal((await prepare("play-a")).accountToken, a.accountToken);
    const digest = "c".repeat(64);
    const claims = await Promise.allSettled([a, b].map(({ accountToken }) => play.claim(randomUUID(), "Production", digest, accountToken)));
    assert.equal(claims.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(claims.find((x) => x.status === "rejected").reason.code, "google_play_subscription_bound_elsewhere");
    const winner = claims[0].status === "fulfilled" ? a : b;
    const binding = await play.resolve(randomUUID(), winner.accountToken);
    await play.claim(randomUUID(), "Production", digest, winner.accountToken);
    const future = new Date(Date.now() + 60_000).toISOString();
    const applied = await billing.applyProviderEvent({ requestId: "google-first", commandId: "google-first", providerEventId: "google-first",
      eventType: "google.subscription.reconciled", payloadDigest: "a".repeat(64), eventCreatedAt: new Date().toISOString(),
      subscription: { billingProvider: "google", id: `google:Production:${digest.slice(0, 40)}`, customerId: winner.accountToken,
        priceId: "monthly", status: "active", quantity: 1, currentPeriodEnd: future, cancelAtPeriodEnd: false,
        spaceId: binding.spaceId, billingOwnerUserId: "play-owner" } });
    assert.equal(applied.plan, "pro");
    const read = await billing.readSpaceBilling({ requestId: randomUUID(), spaceId: binding.spaceId, actorUserId: "play-owner" });
    assert.equal(read.billing.subscription.billingProvider, "google");
    await assert.rejects(billing.portalReference({ requestId: randomUUID(), spaceId: binding.spaceId, actorUserId: "play-owner" }),
      { code: "google_play_managed_subscription" });
    await f.run("UPDATE data.space_billing_subscriptions SET current_period_end=now()-interval '1 second' WHERE space_id=$1", [binding.spaceId]);
    const expired = await billing.readSpaceBilling({ requestId: randomUUID(), spaceId: binding.spaceId, actorUserId: "play-owner" });
    assert.equal(expired.billing.plan, "free", "a store subscription never outlives its period end");
    await f.run(`INSERT INTO control.account_deletion_requests(user_id,request_id,state,receipt_hash,committed_at)
      VALUES('play-owner',$1,'committed',$2,now())`, [randomUUID(), "b".repeat(64)]);
    assert.equal((await play.resolve(randomUUID(), winner.accountToken)).accountDeleted, true);
  } finally { await f.close(); }
});
