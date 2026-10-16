import assert from "node:assert/strict";
import { Client } from "pg";
import { connectionString, integration } from "./postgres-database.fixture.mjs";
import { spaceBilling } from "../../billing-official/src/index.ts";
import { createAuthorityDatabase, PostgresCreditPackRepository } from "../dist/index.js";

// Protect the money boundary: current ownership, exact settlement, concurrent
// webhook/browser replay and a durable receipt independent of replay TTLs.
integration("credit packs admit only Pro owners and settle a payment once under concurrency", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  const id = `pack-${crypto.randomUUID()}`;
  const db = createAuthorityDatabase({ connectionString, shardId: id, applicationName: "credit-packs-test",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 5_000 });
  const packs = new PostgresCreditPackRepository(db, id, spaceBilling);
  const create = (actorUserId = id, commandId = "buy") => packs.create({ requestId: crypto.randomUUID(), commandId, spaceId: id, actorUserId });
  try {
    await client.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ($1,'active','test',now(),now())`, [id]);
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
      VALUES ($1,$1,1,'active','test',now(),now())`, [id]);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$1,'pack test',$1,1,'{}',now(),now())`, [id]);
    await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$1,'owner',1,now(),now())`, [id]);
    await client.query(`INSERT INTO data.space_control_heads (space_id,commit_sequence,updated_at) VALUES ($1,1,now())`, [id]);
    await assert.rejects(create(), error => error.code === "credit_pack_pro_required");
    await client.query(`INSERT INTO data.space_billing_subscriptions
      (space_id,billing_owner_user_id,billing_provider,provider_customer_id,provider_subscription_id,
       provider_price_id,plan,status,seat_quantity,provider_event_created_at,version,created_at,updated_at)
      VALUES ($1,$1,'stripe',$1,$1,'price','pro','active',1,now(),1,now(),now())`, [id]);
    await assert.rejects(create(`${id}-outsider`), error => error.code === "billing_owner_required");
    const [purchase, concurrent] = await Promise.all([create(), create(id, "another-tab")]);
    assert.equal(purchase.purchase_id, concurrent.purchase_id, "one pending purchase across browser tabs");
    assert.equal((await create()).purchase_id, purchase.purchase_id, "creation retries keep the provider idempotency key");
    const payment = { purchaseId: purchase.purchase_id, spaceId: id, ownerUserId: id,
      sessionId: `cs_test_${crypto.randomUUID()}`, amountCents: 1_000, currency: "usd" };
    for (const bad of [{ amountCents: 1 }, { currency: "eur" }, { ownerUserId: "other" }]) {
      await assert.rejects(packs.settle(crypto.randomUUID(), { ...payment, ...bad }), error => error.code === "credit_purchase_mismatch");
    }
    // A webhook can win the race before the checkout endpoint records the session.
    const results = await Promise.all([packs.settle("webhook", payment), packs.settle("browser", payment)]);
    assert.equal(results.filter(result => result.credited).length, 1);
    await packs.record({ requestId: "record-after-webhook", spaceId: id, purchaseId: purchase.purchase_id, sessionId: payment.sessionId });
    await client.query("DELETE FROM data.idempotency_keys WHERE space_id=$1", [id]);
    assert.equal((await packs.settle("after-normal-replays-expire", payment)).replayed, true);
    await assert.rejects(packs.settle("different-session", { ...payment, sessionId: "cs_test_other" }), error => error.code === "credit_purchase_mismatch");
    assert.equal(Number((await client.query("SELECT pack_balance FROM data.space_credit_state WHERE space_id=$1", [id])).rows[0].pack_balance), 10_000);
    assert.equal((await client.query("SELECT status FROM data.space_credit_purchases WHERE space_id=$1", [id])).rows[0].status, "completed");
  } finally {
    for (const table of ["space_credit_purchases", "space_credit_state", "space_billing_subscriptions", "space_control_heads", "idempotency_keys", "outbox", "space_members", "spaces"]) {
      await client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [id]);
    }
    await client.query("DELETE FROM control.space_placement WHERE space_id=$1", [id]);
    await client.query("DELETE FROM control.postgres_shards WHERE shard_id=$1", [id]);
    await client.end();
  }
});
