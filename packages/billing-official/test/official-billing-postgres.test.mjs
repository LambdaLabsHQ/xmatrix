import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";

import {
  CREDITS_PER_SEAT, FREE_SPACE_MESSAGE_LIMIT, GRACE_CREDITS_PER_SEAT, spaceBilling,
} from "../dist/index.js";

const connectionString = process.env.XMATRIX_TEST_POSTGRES_URL;
const integration = connectionString || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true"
  ? test : test.skip;

// The publishing statement's parameter shape: $2 Space id, $6 commit time,
// $10 billable, $13 author kind, $14 credits waived. The others carry the
// message itself and are typed here only.
const publish = (client, spaceId, billable, author = "user", at = new Date().toISOString(), waived = false) =>
  client.query({
    text: `WITH ${spaceBilling.message.ctes}
      SELECT admission.*, COALESCE(NOT $10 OR (${spaceBilling.message.accepts}), FALSE) AS accepted,
        $1::text, $3::text, $4::text, $5::text, $7::text, $8::text, $9::text, $11::text, $12::text,
        $13::text, $14::boolean FROM admission`,
    values: ["", spaceId, "", "", "", at, "", "", "", billable, "", "", author, waived],
  }).then((result) => result.rows[0]);

const transaction = (client) => ({
  query: (query) => client.query({ text: query.text, values: query.values }).then((result) => result.rows),
});

integration("the Free allowance and seat limit hold against the real schema", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  const spaceId = `official-billing-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Official billing test',$1,1,'{}',now(),now())`, [spaceId]);
    await spaceBilling.spaceCreated(transaction(client), { spaceId, now });
    await client.query("UPDATE data.space_billing_usage SET free_message_count=$2 WHERE space_id=$1",
      [spaceId, FREE_SPACE_MESSAGE_LIMIT - 1]);

    const last = await publish(client, spaceId, true);
    assert.equal(last.accepted, true);
    assert.equal(spaceBilling.message.rejection(last, { now }), null);
    const over = await publish(client, spaceId, true);
    assert.equal(over.accepted, false);
    assert.equal(spaceBilling.message.rejection(over, { now })?.code, "payment_required");
    assert.equal((await publish(client, spaceId, false)).accepted, true, "system messages are not billable");

    for (const [index, role] of ["owner", "member", "admin"].entries()) {
      assert.equal(await spaceBilling.seatAdmission(transaction(client), { spaceId, now }), null, role);
      await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
        VALUES ($1,$2,$3,1,now(),now())`, [spaceId, `user-${index}`, role]);
    }
    assert.equal((await spaceBilling.seatAdmission(transaction(client), { spaceId, now }))?.code,
      "billing_seat_limit");
    assert.equal(await spaceBilling.spaceDeletion(transaction(client), { spaceId, now }), null);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

integration("a paid Space's Agent credits run included, packs, grace, then refuse", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  const spaceId = `official-credits-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const state = (values) => client.query(`UPDATE data.space_credit_state SET included_used=$2,pack_balance=$3,
    grace_used=$4,pack_used=0 WHERE space_id=$1`, [spaceId, values.included, values.packs ?? 0, values.grace ?? 0]);
  const credits = async () => (await client.query(
    "SELECT * FROM data.space_credit_state WHERE space_id=$1", [spaceId])).rows[0];
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Credits test',$1,1,'{}',now(),now())`, [spaceId]);
    await spaceBilling.spaceCreated(transaction(client), { spaceId, now });
    await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,'owner-1','owner',1,now(),now())`, [spaceId]);
    await client.query(`INSERT INTO data.space_billing_subscriptions
      (space_id,billing_owner_user_id,provider_customer_id,provider_subscription_id,provider_price_id,plan,status,
       seat_quantity,provider_event_created_at,version,created_at,updated_at)
      VALUES ($1,'owner-1','cus_test',$1,'price_test','pro','active',1,now(),1,now(),now())`, [spaceId]);

    // People write for free; an Agent's first write opens the month.
    assert.equal((await publish(client, spaceId, true, "user")).credit_metered, false);
    assert.equal(await credits(), undefined);
    const first = await publish(client, spaceId, true, "agent");
    assert.equal(first.accepted, true);
    assert.equal(Number((await credits()).included_used), 1);
    assert.equal((await publish(client, spaceId, false, "agent")).credit_metered, false, "system notices are free");

    // 80% of the included credits is told once.
    await state({ included: CREDITS_PER_SEAT * 0.8 - 1 });
    const eighty = await publish(client, spaceId, true, "app");
    assert.equal(spaceBilling.message.notice(eighty)?.key.endsWith(":1"), true);
    assert.equal(spaceBilling.message.notice(await publish(client, spaceId, true, "agent")), null);

    // Included credits gone: packs are used before the grace.
    await state({ included: CREDITS_PER_SEAT, packs: 1 });
    assert.equal((await publish(client, spaceId, true, "agent")).accepted, true);
    assert.deepEqual([Number((await credits()).pack_balance), Number((await credits()).pack_used)], [0, 1]);
    assert.equal((await publish(client, spaceId, true, "agent")).accepted, true);
    assert.equal(Number((await credits()).grace_used), 1);

    // The last grace credit pauses Agents and says so; the next write is refused.
    await state({ included: CREDITS_PER_SEAT, grace: GRACE_CREDITS_PER_SEAT - 1 });
    const last = await publish(client, spaceId, true, "agent");
    assert.equal(last.accepted, true);
    assert.equal(spaceBilling.message.notice(last)?.key.endsWith(":3"), true);
    const refused = await publish(client, spaceId, true, "agent");
    assert.equal(refused.accepted, false);
    assert.equal(spaceBilling.message.rejection(refused, { now })?.code, "credits_exhausted");
    assert.equal((await publish(client, spaceId, true, "user")).accepted, true, "people still write");
    const waived = await publish(client, spaceId, true, "agent", now, true);
    assert.deepEqual([waived.accepted, waived.credit_metered], [true, false], "an operator Space is not charged");
    assert.equal((await spaceBilling.agentWrite(transaction(client),
      { spaceId, now, kind: "page_revision" }))?.code, "credits_exhausted");

    // A new month starts the counters again and keeps the pack balance.
    await client.query("UPDATE data.space_credit_state SET pack_balance=7 WHERE space_id=$1", [spaceId]);
    const next = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 2)).toISOString();
    assert.equal((await publish(client, spaceId, true, "agent", next)).accepted, true);
    const rolled = await credits();
    assert.deepEqual([Number(rolled.included_used), Number(rolled.grace_used), Number(rolled.pack_balance),
      Number(rolled.notice_level)], [1, 0, 7, 0]);
    assert.equal(await spaceBilling.agentWrite(transaction(client), { spaceId, now: next, kind: "page_revision" }), null);
    assert.equal(Number((await credits()).included_used), 2);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

integration("two Agent writes racing for the last credit admit exactly one", async () => {
  const setup = new Client({ connectionString });
  const [left, right] = [new Client({ connectionString }), new Client({ connectionString })];
  await Promise.all([setup.connect(), left.connect(), right.connect()]);
  const spaceId = `official-credits-race-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const periodStart = `${now.slice(0, 7)}-01`;
  try {
    await setup.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$1,'Credits race',$1,1,'{}',now(),now())`, [spaceId]);
    await setup.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,'owner-1','owner',1,now(),now())`, [spaceId]);
    await setup.query(`INSERT INTO data.space_billing_subscriptions
      (space_id,billing_owner_user_id,provider_customer_id,provider_subscription_id,provider_price_id,plan,status,
       seat_quantity,provider_event_created_at,version,created_at,updated_at)
      VALUES ($1,'owner-1','cus_race',$1,'price_test','pro','active',1,now(),1,now(),now())`, [spaceId]);
    await setup.query(`INSERT INTO data.space_credit_state
      (space_id,period_start,included_used,grace_used,version,created_at,updated_at)
      VALUES ($1,$2,$3,$4,1,now(),now())`, [spaceId, periodStart, CREDITS_PER_SEAT, GRACE_CREDITS_PER_SEAT - 1]);

    await left.query("BEGIN");
    await right.query("BEGIN");
    const first = await publish(left, spaceId, true, "agent", now);
    const second = publish(right, spaceId, true, "agent", now); // waits on the Space's credit row
    await left.query("COMMIT");
    const late = await second;
    await right.query("COMMIT");
    assert.deepEqual([first.accepted, late.accepted], [true, false]);
    assert.equal(spaceBilling.message.rejection(late, { now })?.code, "credits_exhausted");
  } finally {
    for (const table of ["space_credit_state", "space_billing_subscriptions", "space_members", "spaces"]) {
      await setup.query(`DELETE FROM data.${table} WHERE space_id=$1`, [spaceId]);
    }
    await Promise.all([setup.end(), left.end(), right.end()]);
  }
});

integration("an account creates Spaces while it owns fewer than two Free ones", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  const owner = `official-owner-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const personal = `${owner}-personal`;
  const create = (spaceId) => client.query(`INSERT INTO data.spaces
    (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,'Free Space allowance test',$1,1,'{}',now(),now())`, [spaceId, owner]);
  const admit = () => spaceBilling.spaceCreation(transaction(client),
    { ownerUserId: owner, now, personalSpaceIds: [personal, `private:${owner}`] });
  try {
    await client.query("BEGIN");
    await create(personal);
    await create(`private:${owner}`);
    await create(`${owner}-a`);
    assert.equal(await admit(), null, "the Spaces the product made for the account are not counted");
    await create(`${owner}-b`);
    assert.deepEqual(await admit(), {
      code: "free_space_limit", status: 402,
      message: "Upgrade an existing Space to Pro or delete one to create another Free Space",
      details: { freeSpaces: 2, freeSpaceLimit: 2 },
    });

    await client.query(`INSERT INTO data.space_billing_subscriptions
      (space_id,billing_owner_user_id,billing_provider,provider_customer_id,provider_subscription_id,
       provider_price_id,plan,status,seat_quantity,provider_event_created_at,version,created_at,updated_at)
      VALUES ($1,$2,'stripe','customer',$1,'price','pro','active',1,now(),1,now(),now())`, [`${owner}-a`, owner]);
    assert.equal(await admit(), null, "a Space on a paid plan is not Free");
    await client.query(`UPDATE data.space_billing_subscriptions SET billing_provider='apple',
      current_period_end=now()-interval '1 day' WHERE space_id=$1`, [`${owner}-a`]);
    assert.equal((await admit())?.code, "free_space_limit", "a lapsed App Store subscription is Free again");

    await client.query(`INSERT INTO data.space_deletions
      (space_id,space_name,owner_user_id,requested_at,purge_after,state,members_json,automations_json,version,updated_at)
      VALUES ($1,'deleted',$2,now(),now()+interval '7 days','scheduled','[]','[]',1,now())`, [`${owner}-b`, owner]);
    assert.equal(await admit(), null, "a deleted Space is no longer owned");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
