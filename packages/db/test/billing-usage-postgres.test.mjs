import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAuthorityDatabase, PostgresBillingRepository } from "../dist/index.js";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

integration("Billing itemizes who used the allowance: this month's credits, every Free write", async () => {
  const f = await isolatedPostgres("billing_usage", { shard: true });
  const billing = new PostgresBillingRepository(
    createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" }), "shard-0");
  const space = "usage-space";
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  const row = (period, meter, kind, owner, name, write, units) => f.run(`INSERT INTO data.space_credit_usage
    (space_id,period_start,meter,author_kind,owner_user_id,author_name,write_kind,units,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())`, [space, period, meter, kind, owner, name, write, units]);
  const read = (itemize = { creditsWaived: false }) =>
    billing.readSpaceBilling({ requestId: randomUUID(), spaceId: space, actorUserId: "ada", itemize });
  try {
    await f.run(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active','test',now(),now())`, [space]);
    await f.run(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,'ada',$1,$1,1,'{}',now(),now())`, [space]);
    await f.run(`INSERT INTO data.space_members(space_id,user_id,role,version,email,display_name,created_at,updated_at)
      VALUES ($1,'ada','owner',1,'ada@example.com','Ada',now(),now()),
        ($1,'bo','member',1,'bo@example.com',NULL,now(),now())`, [space]);

    // Free: every write the Space ever made, people's included.
    await row(lastMonth, "free", "user", "ada", "", "message", 3);
    await row(month, "free", "user", "ada", "", "page_revision", 2);
    await row(month, "free", "agent", "bo", "codex", "message", 4);
    const free = await read();
    assert.equal(free.billing.usage.meter, "free");
    assert.deepEqual(free.billing.usage.items.map((item) => [item.kind, item.ownerName, item.name, item.messages,
      item.pageRevisions, item.units]), [["user", "Ada", "", 3, 2, 5], ["agent", "bo@example.com", "codex", 4, 0, 4]]);
    assert.equal((await billing.readSpaceBilling({ requestId: randomUUID(), spaceId: space, actorUserId: "ada" }))
      .billing.usage, undefined, "only an itemizing read pays for the breakdown");

    // Pro: this month's credits only, with each person's paid X calls.
    await f.run(`INSERT INTO data.space_billing_subscriptions
      (space_id,billing_owner_user_id,provider_customer_id,provider_subscription_id,provider_price_id,plan,status,
       seat_quantity,provider_event_created_at,version,created_at,updated_at)
      VALUES ($1,'ada','cus_usage',$1,'price_test','pro','active',2,now(),1,now(),now())`, [space]);
    await row(lastMonth, "credit", "agent", "ada", "claude", "message", 50);
    await row(month, "credit", "agent", "ada", "claude", "message", 7);
    await row(month, "credit", "agent", "ada", "claude", "page_revision", 3);
    await row(month, "credit", "app", "", "github", "message", 2);
    await f.run(`INSERT INTO data.paid_call_receipts (space_id,call_id,actor_user_id,request_digest,attempt_token,kind,
      reserved_units,reserved_credits,allocation_json,status,actual_units,actual_credits,outcome,created_at,updated_at)
      VALUES ($1,'x:1','bo','d','t','x_post',1,30,'{}','settled',1,30,'ok',now(),now()),
        ($1,'x:2','bo','d','t','x_post_read',10,100,'{}','reserved',NULL,NULL,NULL,now(),now())`, [space]);
    const pro = await read({ creditsWaived: true });
    assert.equal(pro.billing.plan, "pro");
    assert.equal(pro.billing.usage.meter, "credit");
    assert.equal(pro.billing.usage.waived, true);
    assert.deepEqual(pro.billing.usage.items.map((item) => [item.kind, item.ownerUserId, item.name, item.messages,
      item.pageRevisions, item.units]), [
      ["x", "bo", "", 0, 0, 130], ["agent", "ada", "claude", 7, 3, 10], ["app", "", "github", 2, 0, 2]]);
    assert.ok(pro.billing.usage.since);
  } finally { await f.close(); }
});
