import assert from "node:assert/strict";
import { test } from "node:test";

import { FREE_SPACE_MESSAGE_LIMIT, spaceBilling } from "../dist/index.js";

const NOW = "2026-10-02T12:00:00.000Z";
const LATER = "2026-10-09T12:00:00.000Z";

function transaction(rows) {
  const calls = [];
  return {
    calls,
    async query(query) {
      calls.push(query);
      return rows[query.name] ?? [];
    },
  };
}

test("a Free Space admits its first three human seats", async () => {
  for (const [count, admitted] of [[2, true], [3, false]]) {
    const tx = transaction({ official_space_seat_count_v1: [{ count }] });
    const rejection = await spaceBilling.seatAdmission(tx, { spaceId: "space-1", now: NOW });
    assert.equal(rejection === null, admitted, String(count));
    if (rejection) {
      assert.equal(rejection.code, "billing_seat_limit");
      assert.deepEqual(rejection.details, { spaceId: "space-1", usedSeats: 3, seatLimit: 3, paid: false });
    }
  }
});

test("a paid Space admits the seats it bought, and none during a past-due grace period", async () => {
  const paid = transaction({
    official_space_seat_subscription_v1: [{ status: "active", grace_until: null, seat_quantity: 10 }],
    official_space_seat_count_v1: [{ count: 9 }],
  });
  assert.equal(await spaceBilling.seatAdmission(paid, { spaceId: "space-1", now: NOW }), null);
  assert.match(paid.calls[0].text, /FOR UPDATE/u);

  const pastDue = transaction({
    official_space_seat_subscription_v1: [{ status: "past_due", grace_until: LATER, seat_quantity: 10 }],
  });
  assert.equal((await spaceBilling.seatAdmission(pastDue, { spaceId: "space-1", now: NOW }))?.code,
    "billing_grace_read_only");
});

test("a Space with a live subscription or checkout cannot be deleted", async () => {
  const subscribed = transaction({ official_space_delete_subscription_v1: [{ status: "active" }] });
  assert.equal((await spaceBilling.spaceDeletion(subscribed, { spaceId: "space-1", now: NOW }))?.code, "conflict");
  const canceled = transaction({ official_space_delete_subscription_v1: [{ status: "canceled" }] });
  assert.equal(await spaceBilling.spaceDeletion(canceled, { spaceId: "space-1", now: NOW }), null);
  const checkout = transaction({ official_space_delete_checkout_v1: [{ checkout_intent_id: "c-1" }] });
  assert.equal((await spaceBilling.spaceDeletion(checkout, { spaceId: "space-1", now: NOW }))?.code, "conflict");
});

test("a new Space starts its Free message count at zero", async () => {
  const tx = transaction({});
  await spaceBilling.spaceCreated(tx, { spaceId: "space-1", now: NOW });
  assert.equal(tx.calls[0].name, "official_space_billing_usage_create_v1");
  assert.deepEqual(tx.calls[0].values, ["space-1", NOW]);
});

test("the Free message counter advances in the publishing statement, without a held row lock", () => {
  const { ctes, accepts } = spaceBilling.message;
  assert.match(ctes, /free_message_count=free_message_count\+1/u);
  assert.match(ctes, new RegExp(`free_message_count<${FREE_SPACE_MESSAGE_LIMIT}`, "u"));
  assert.match(ctes, /RETURNING free_message_count/u);
  assert.match(ctes, /admission AS MATERIALIZED/u);
  assert.doesNotMatch(ctes, /FOR UPDATE/u);
  assert.match(accepts, /seat_count<=seat_quantity/u);
});

test("an unpublished billable message names why", () => {
  const reject = (row) => spaceBilling.message.rejection(row, { now: NOW })?.code ?? null;
  assert.equal(reject({ status: null, prior_free_message_count: 499, free_message_count: 500 }), null);
  assert.equal(reject({ status: null, prior_free_message_count: 500, free_message_count: null }), "payment_required");
  assert.equal(reject({ status: null, prior_free_message_count: null, free_message_count: null }),
    "billing_usage_unavailable");
  assert.equal(reject({ status: "active", seat_count: 4, seat_quantity: 3 }), "billing_seat_limit");
  assert.equal(reject({ status: "trialing", seat_count: 3, seat_quantity: 3 }), null);
  assert.equal(reject({ status: "past_due", grace_until: LATER }), "billing_grace_read_only");
});
