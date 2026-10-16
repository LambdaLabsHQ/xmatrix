import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";

import { FREE_SPACE_MESSAGE_LIMIT, spaceBilling } from "../dist/index.js";

const connectionString = process.env.XMATRIX_TEST_POSTGRES_URL;
const integration = connectionString || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true"
  ? test : test.skip;

// The publishing statement's parameter shape: $2 Space id, $6 commit time,
// $10 billable. The others carry the message itself and are typed here only.
const publish = (client, spaceId, billable) => client.query({
  text: `WITH ${spaceBilling.message.ctes}
    SELECT admission.*, COALESCE(NOT $10 OR (${spaceBilling.message.accepts}), FALSE) AS accepted,
      $1::text, $3::text, $4::text, $5::text, $7::text, $8::text, $9::text FROM admission`,
  values: ["", spaceId, "", "", "", new Date().toISOString(), "", "", "", billable],
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
