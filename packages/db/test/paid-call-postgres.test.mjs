import assert from "node:assert/strict";
import { Client } from "pg";
import { connectionString, integration, postgresDatabase } from "./postgres-database.fixture.mjs";
import { spaceBilling } from "../../billing-official/dist/index.js";
import { createAuthorityDatabase, DatabaseCommitUnknownError, PostgresPaidCallRepository } from "../dist/index.js";

// Own the financial contract on real concurrent PostgreSQL connections:
// complete admission, allocation/refund across buckets, and permanent receipts.
async function fixture(run) {
  const id = `paid-call-${crypto.randomUUID()}`;
  const client = new Client({ connectionString });
  await client.connect();
  const db = createAuthorityDatabase({ connectionString, shardId: id, applicationName: "paid-call-test",
    statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 5_000 });
  const repository = new PostgresPaidCallRepository(db, spaceBilling);
  const base = { spaceId: id, actorUserId: id, creditsWaived: false };
  const reserve = (callId, kind = "x_post", units = 1, extra = {}) => repository.reserve({ ...base, callId, kind, units, ...extra });
  const settle = (callId, actualUnits = 1) => repository.settle({ spaceId: id, callId, actualUnits, outcome: "ok", announce: true });
  const counters = async () => (await client.query(`SELECT included_used,pack_used,grace_used,pack_balance
    FROM data.space_credit_state WHERE space_id=$1`, [id])).rows.map(row => Object.values(row).map(Number))[0];
  try {
    await client.query(`INSERT INTO control.postgres_shards
      (shard_id,state,capacity_class,created_at,updated_at) VALUES ($1,'active','paid-call-test',now(),now())`, [id]);
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at) VALUES ($1,$1,1,'active','test',now(),now())`, [id]);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Paid provider fixture',$1,1,'{}',now(),now())`, [id]);
    await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$1,'owner',1,now(),now())`, [id]);
    await client.query("INSERT INTO data.space_control_heads (space_id,commit_sequence,updated_at) VALUES ($1,0,now())", [id]);
    const pro = () => client.query(`INSERT INTO data.space_billing_subscriptions
      (space_id,billing_owner_user_id,billing_provider,provider_customer_id,provider_subscription_id,provider_price_id,
       plan,status,seat_quantity,provider_event_created_at,version,created_at,updated_at)
      VALUES ($1,$1,'stripe',$1,$1,'price','pro','active',1,now(),1,now(),now())`, [id]);
    await run({ id, client, db, repository, base, reserve, settle, counters, pro });
  } finally {
    for (const table of ["paid_call_receipts", "space_credit_state", "space_billing_subscriptions", "space_control_heads",
      "idempotency_keys", "outbox", "space_members", "spaces"]) await client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [id]);
    await client.query("DELETE FROM control.space_placement WHERE space_id=$1", [id]);
    await client.query("DELETE FROM control.postgres_shards WHERE shard_id=$1", [id]);
    await client.end();
  }
}

integration("paid X admits Pro members, splits a complete charge and refunds it once", () => fixture(async f => {
  await assert.rejects(f.reserve("free"), error => error.code === "paid_x_pro_required");
  assert.equal((await f.client.query("SELECT count(*) FROM data.paid_call_receipts WHERE space_id=$1", [f.id])).rows[0].count, "0");
  await f.pro();
  await assert.rejects(f.reserve("outsider", "x_post", 1, { actorUserId: "outsider" }), error => error.code === "forbidden");
  await f.reserve("initialize");
  await f.settle("initialize");
  await f.client.query(`UPDATE data.space_credit_state SET included_used=4990,pack_balance=20,pack_used=0,grace_used=0
    WHERE space_id=$1`, [f.id]);
  const charge = await f.reserve("split", "x_post_url");
  assert.equal(charge.reservedCredits, 400);
  assert.deepEqual(await f.counters(), [5000,20,370,0]);
  const refunds = await Promise.all([f.settle("split", 0), f.settle("split", 0)]);
  assert.equal(refunds.filter(result => !result.replayed).length, 1);
  assert.equal(refunds[0].chargedCredits, 0);
  assert.deepEqual(await f.counters(), [4990,0,0,20]);
  await f.settle("split", 0);
  assert.deepEqual(await f.counters(), [4990,0,0,20], "a settlement replay never refunds twice");
  await f.client.query("DELETE FROM data.idempotency_keys WHERE space_id=$1", [f.id]);
  assert.equal((await f.reserve("split", "x_post_url")).replayed, true, "permanent receipt outlives ordinary replays");
  await assert.rejects(f.settle("split", 1), error => error.code === "paid_call_settlement_conflict");
  await assert.rejects(f.reserve("split", "x_post"), error => error.code === "idempotency_conflict");
  const waived = await f.reserve("operator", "x_post_url", 1, { creditsWaived: true });
  assert.equal(waived.reservedCredits, 0);
  await f.settle("operator");
  assert.deepEqual(await f.counters(), [4990,0,0,20]);
}));

integration("a lost admission COMMIT refunds only its invocation, never an in-flight original on replay", () => fixture(async f => {
  await f.pro();
  const uncertain = new PostgresPaidCallRepository({ ...f.db, async transaction(context, callback) {
    const result = await f.db.transaction(context, callback);
    if (context.placement && context.operation === "billing.paid-call.reserve") throw new DatabaseCommitUnknownError("08006");
    return result;
  } }, spaceBilling);
  const request = callId => uncertain.reserve({ ...f.base, callId, kind: "x_post_url", units: 1 });
  await assert.rejects(request("unsent"), error => error.code === "paid_call_admission_unconfirmed" && /refunded/u.test(error.message));
  assert.deepEqual(await f.counters(), [0,0,0,0], "an unsent reserve is released after the lost acknowledgement");
  assert.equal((await f.reserve("unsent", "x_post_url")).replayed, true);
  await f.reserve("original-running", "x_post_url");
  await assert.rejects(request("original-running"), error => error.code === "paid_call_admission_unconfirmed");
  assert.deepEqual(await f.counters(), [400,0,0,0], "the replay's uncertain COMMIT cannot refund another invocation");
  await f.settle("original-running");
  assert.deepEqual(await f.counters(), [400,0,0,0]);
}));

integration("racing paid calls cannot overspend or claim the same attempt twice", () => fixture(async f => {
  await f.pro();
  await f.reserve("initialize");
  await f.client.query("UPDATE data.space_credit_state SET included_used=5000,grace_used=2470 WHERE space_id=$1", [f.id]);
  const results = await Promise.allSettled([f.reserve("last-a"), f.reserve("last-b")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "credits_exhausted");
  assert.deepEqual(await f.counters(), [5000,0,2500,0]);
  await f.client.query("UPDATE data.space_credit_state SET grace_used=2400 WHERE space_id=$1", [f.id]);
  const duplicate = await Promise.all([f.reserve("same"), f.reserve("same")]);
  assert.equal(duplicate.filter(r => !r.replayed).length, 1);
  assert.equal(Number((await f.client.query("SELECT grace_used FROM data.space_credit_state WHERE space_id=$1", [f.id])).rows[0].grace_used), 2430);
  await f.client.query("UPDATE data.space_credit_state SET grace_used=2499 WHERE space_id=$1", [f.id]);
  await assert.rejects(f.reserve("not-enough"), error => error.code === "credits_exhausted");
  assert.equal(Number((await f.client.query("SELECT grace_used FROM data.space_credit_state WHERE space_id=$1", [f.id])).rows[0].grace_used), 2499,
    "insufficient funds leave no partial debit");
  await f.client.query("UPDATE data.space_credit_state SET grace_used=2470 WHERE space_id=$1", [f.id]);
  const [paid, page] = await Promise.allSettled([f.reserve("paid-versus-page"),
    postgresDatabase(f.client).transaction(tx => spaceBilling.durableWrite(tx, {
      spaceId: f.id, now: new Date().toISOString(), kind: "page_revision", author: "agent" }))]);
  assert.equal(Number(paid.status === "fulfilled") + Number(page.status === "fulfilled" && page.value === null), 1,
    "a page write and paid X reserve serialize on the same balance");
  const state = await f.counters();
  assert.ok(state[2] === 2471 || state[2] === 2500);
}));

integration("bounded media and read reservations release unused units and expired-month refunds never mint credits", () => fixture(async f => {
  await f.pro();
  const group = await f.reserve("upload", "x_media", 4);
  assert.equal(group.reservedCredits, 120);
  const done = await f.settle("upload", 2);
  assert.equal(done.chargedCredits, 60);
  assert.deepEqual(await f.counters(), [60,0,0,0]);
  const timeline = await f.reserve("timeline", "x_post_read", 10);
  assert.equal(timeline.reservedCredits, 100);
  await f.settle("timeline", 3);
  assert.deepEqual(await f.counters(), [90,0,0,0]);
  await f.client.query("UPDATE data.space_credit_state SET included_used=4990,pack_balance=20 WHERE space_id=$1", [f.id]);
  await f.reserve("month-end", "x_post_url");
  await f.client.query(`UPDATE data.space_credit_state SET period_start=period_start+interval '1 month',
    included_used=17,pack_used=5,grace_used=7 WHERE space_id=$1`, [f.id]);
  await f.settle("month-end", 0);
  assert.deepEqual(await f.counters(), [17,5,7,20]);
}));
