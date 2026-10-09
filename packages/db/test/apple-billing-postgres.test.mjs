import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAuthorityDatabase, PostgresAppleBillingRepository, PostgresBillingRepository } from "../dist/index.js";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

integration("Apple purchase ownership is immutable under concurrent claims and billing respects expiry", async () => {
  const f = await isolatedPostgres("apple_billing", { shard: true });
  const db = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const billing = new PostgresBillingRepository(db, "shard-0");
  const apple = new PostgresAppleBillingRepository(db, billing);
  try {
    for (const space of ["apple-a", "apple-b"]) {
      await f.run(`INSERT INTO control.space_placement
        (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
        VALUES ($1,'shard-0',1,'active','test',now(),now())`, [space]);
      await f.run(`INSERT INTO data.spaces
        (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
        VALUES ($1,'apple-owner',$1,$1,1,'{}',now(),now())`, [space]);
      await f.run("INSERT INTO data.space_control_heads VALUES ($1,0,now())", [space]);
      await f.run(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
        VALUES ($1,'apple-owner','owner',1,now(),now())`, [space]);
    }
    const prepare = (spaceId, actorUserId = "apple-owner") => apple.prepare({
      requestId: randomUUID(), commandId: randomUUID(), actorUserId, spaceId,
      interval: "month", productId: "sh.xmatrix.app.pro.monthly",
    });
    await assert.rejects(prepare("apple-a", "outsider"));
    const [a, b] = await Promise.all([prepare("apple-a"), prepare("apple-b")]);
    assert.notEqual(a.appAccountToken, b.appAccountToken);
    assert.equal((await prepare("apple-a")).appAccountToken, a.appAccountToken);
    const claims = await Promise.allSettled([a, b].map(({ appAccountToken }) =>
      apple.claim(randomUUID(), "Production", "1000001", appAccountToken)));
    assert.equal(claims.filter(x => x.status === "fulfilled").length, 1);
    const loser = claims.find(x => x.status === "rejected");
    assert.equal(loser.reason.code, "apple_subscription_bound_elsewhere");
    const winner = claims[0].status === "fulfilled" ? a : b;
    const binding = await apple.resolve(randomUUID(), winner.appAccountToken);
    await apple.claim(randomUUID(), "Production", "1000001", winner.appAccountToken);
    const apply = (end, commandId, signedAt) => billing.applyProviderEvent({ requestId: commandId,
      commandId, providerEventId: commandId, eventType: "apple.subscription.reconciled",
      payloadDigest: "a".repeat(64), eventCreatedAt: signedAt,
      subscription: { billingProvider: "apple", id: "apple:Production:1000001", customerId: winner.appAccountToken,
        priceId: "sh.xmatrix.app.pro.monthly", status: "active", quantity: 1,
        currentPeriodEnd: end, cancelAtPeriodEnd: true, spaceId: binding.spaceId, billingOwnerUserId: "apple-owner" },
    });
    const signedAt = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const first = await apply(future, "apple-first", signedAt);
    assert.equal(first.plan, "pro");
    assert.equal((await apply(future, "apple-first", signedAt)).plan, "pro");
    await assert.rejects(billing.createCheckoutIntent({ requestId: "stripe-conflict", commandId: "stripe-conflict",
      actorUserId: "apple-owner", spaceId: binding.spaceId, interval: "month", priceId: "price_test", seatQuantity: 1 }));
    await f.run("UPDATE data.space_billing_subscriptions SET current_period_end=now()-interval '1 second' WHERE space_id=$1", [binding.spaceId]);
    const expired = await billing.readSpaceBilling({ requestId: randomUUID(), spaceId: binding.spaceId, actorUserId: "apple-owner" });
    assert.equal(expired.billing.plan, "free");
    // Restore cannot silently move the original transaction even after expiry.
    await assert.rejects(apple.claim(randomUUID(), "Production", "1000001",
      winner === a ? b.appAccountToken : a.appAccountToken), { code: "apple_subscription_bound_elsewhere" });
  } finally { await f.close(); }
});
