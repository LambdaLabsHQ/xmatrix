import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAuthorityDatabase, PostgresBillingGrantRepository, PostgresBillingRepository } from "../dist/index.js";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

integration("complimentary Pro is one month per person, never over a live subscription, and gives way to a purchase", async () => {
  const f = await isolatedPostgres("billing_grants", { shard: true });
  const db = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const billing = new PostgresBillingRepository(db, "shard-0");
  const grants = new PostgresBillingGrantRepository(db, billing);
  try {
    const space = async (spaceId, owner, members = []) => {
      await f.run(`INSERT INTO control.space_placement
        (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
        VALUES ($1,'shard-0',1,'active','test',now(),now())`, [spaceId]);
      await f.run(`INSERT INTO data.spaces
        (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
        VALUES ($1,$2,$1,$1,1,'{}',now(),now())`, [spaceId, owner]);
      await f.run("INSERT INTO data.space_control_heads VALUES ($1,0,now())", [spaceId]);
      for (const [user, role] of [[owner, "owner"], ...members]) await f.run(`INSERT INTO data.space_members
        (space_id,user_id,role,version,created_at,updated_at) VALUES ($1,$2,$3,1,now(),now())`, [spaceId, user, role]);
    };
    await space("grant-a", "alice", [["bob", "member"], ["viewer-1", "viewer"]]);
    await space("grant-b", "bob");
    await space("grant-paid", "carol");
    const give = (userId, spaceId, reference, extra = {}) => grants.grant({ requestId: randomUUID(), userId, spaceId,
      reference, reason: "Reproducible onboarding report", actor: "test-operator", ...extra });
    const read = (spaceId, actorUserId) => billing.readSpaceBilling({ requestId: randomUUID(), spaceId, actorUserId });

    const first = await give("alice", "grant-a", "https://github.com/o/r/issues/1");
    assert.equal(first.replayed, false);
    assert.equal(first.grant.seatQuantity, 2, "seats cover owner and member, not viewers");
    const days = (Date.parse(first.grant.periodEnd) - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, "a grant lasts thirty days");
    const granted = (await read("grant-a", "alice")).billing;
    assert.equal(granted.plan, "pro");
    assert.equal(granted.subscription.billingProvider, "grant");
    assert.equal(granted.subscription.cancelAtPeriodEnd, true);
    assert.deepEqual(granted.seats, { used: 2, limit: 2 });

    const again = await give("alice", "grant-a", "https://github.com/o/r/issues/1");
    assert.equal(again.replayed, true);
    assert.equal(again.grant.grantId, first.grant.grantId);
    await assert.rejects(give("alice", "grant-a", "https://github.com/o/r/issues/2"), { code: "billing_grant_already_used" });
    await assert.rejects(give("bob", "grant-b", "https://github.com/o/r/issues/1"), { code: "billing_grant_reference_used" });

    // Only an owner can receive one, and a refusal gives the person their grant back.
    await assert.rejects(give("bob", "grant-a", "https://github.com/o/r/issues/3"), { code: "billing_owner_required" });
    // A Space someone already pays for is never given one.
    await f.run(`INSERT INTO data.space_billing_subscriptions
      (space_id,billing_owner_user_id,provider_customer_id,provider_subscription_id,provider_price_id,plan,status,
       seat_quantity,current_period_end,cancel_at_period_end,provider_event_created_at,version,created_at,updated_at,billing_provider)
      VALUES ('grant-paid','carol','cus_1','sub_1','price_1','pro','active',1,now()+interval '20 days',false,now(),1,now(),now(),'stripe')`);
    await assert.rejects(give("carol", "grant-paid", "mail:carol"), { code: "billing_subscription_active" });
    assert.equal(await grants.read(randomUUID(), "carol"), null, "the refused grant was released");
    const bobs = await give("bob", "grant-b", "https://github.com/o/r/issues/3");
    assert.equal(bobs.grant.userId, "bob");

    await assert.rejects(give("dave", "grant-b", "mail:dave", { dailyLimit: 2 }), { code: "billing_grant_daily_limit" });

    await assert.rejects(billing.portalReference({ requestId: randomUUID(), spaceId: "grant-a", actorUserId: "alice" }),
      { code: "complimentary_subscription" });
    // Buying Pro is open during the grant, and the purchase replaces it.
    await billing.createCheckoutIntent({ requestId: randomUUID(), commandId: randomUUID(), actorUserId: "alice",
      spaceId: "grant-a", interval: "month", priceId: "price_test", seatQuantity: 2 });
    const bought = await billing.applyProviderEvent({ requestId: "evt-1", commandId: "evt-1", providerEventId: "evt-1",
      eventType: "customer.subscription.created", payloadDigest: "a".repeat(64), eventCreatedAt: new Date().toISOString(),
      subscription: { id: "sub_alice", customerId: "cus_alice", priceId: "price_test", status: "active", quantity: 2,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(), cancelAtPeriodEnd: false,
        spaceId: "grant-a", billingOwnerUserId: "alice" } });
    assert.equal(bought.plan, "pro");
    assert.equal(bought.subscription.billingProvider, "stripe");

    // The grant ends on its own, and then the owner can buy Pro.
    await f.run("UPDATE data.space_billing_subscriptions SET current_period_end=now()-interval '1 second' WHERE space_id='grant-b'");
    assert.equal((await read("grant-b", "bob")).billing.plan, "free");
    await billing.createCheckoutIntent({ requestId: randomUUID(), commandId: randomUUID(), actorUserId: "bob",
      spaceId: "grant-b", interval: "month", priceId: "price_test", seatQuantity: 1 });
  } finally { await f.close(); }
});
