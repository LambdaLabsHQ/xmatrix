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
