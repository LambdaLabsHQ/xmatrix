import assert from "node:assert/strict";
import test from "node:test";

import { BillingControlError, PostgresBillingRepository } from "../dist/billing-control.js";
import { createAuthorityDatabaseRouter } from "../dist/router.js";
import { routedEntityDirectory, publicationPlacement, recordingDatabase as database } from "./recording-database.fixture.mjs";

test("billing checkout creation is owner-scoped, idempotent, and auditable", async () => {
  const db = database((query) => publicationPlacement(query) ?? ( query.name === "billing_checkout_route_source_v1"
        ? [{ route_version: 3, updated_at: "2026-08-30T00:00:00.000Z" }]
    : query.name === "billing_require_owner_v1"
      ? [{ user_id: "owner-1" }]
      : query.name === "billing_checkout_seats_v1"
        ? [{ count: 1 }]
        : query.name === "billing_head_advance_v1"
          ? [{ commit_sequence: 3 }]
          : []));
  const result = await new PostgresBillingRepository(db, "shard-0").createCheckoutIntent({
    requestId: "request-1", commandId: "command-1", spaceId: "space-1",
    actorUserId: "owner-1", interval: "month", priceId: "price-1", seatQuantity: 2,
  });

  assert.equal(result.intent.spaceId, "space-1");
  for (const name of ["billing_checkout_insert_v1", "billing_outbox_v1", "billing_idempotency_write_v1"]) {
    assert.equal(db.calls.some((call) => call.name === name), true, name);
  }
  assert.equal(db.calls.some((call) => call.name === "entity_space_route_publish_v1"), true);
});

test("billing checkout session records route an opaque intent through the global directory", async () => {
  const directory = routedEntityDirectory({ entity_kind: "billing-checkout", entity_id: "intent-1", space_id: "space-1",
        shard_id: "shard-1", placement_epoch: 7, entity_version: 1, route_version: 3 });
  const shard0 = database(() => []);
  const shard1 = database((query) => query.name === "billing_checkout_record_lock_v1"
    ? [{ status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString(),
        provider_checkout_session_id: null }]
    : query.name === "billing_head_advance_v1" ? [{ commit_sequence: 4 }] : []);
  const router = createAuthorityDatabaseRouter({ directory, shards: { "shard-0": shard0,
    "shard-1": shard1 } });

  const result = await new PostgresBillingRepository(router, "shard-0").recordCheckoutSession({
    requestId: "record-routed", commandId: "command-routed",
    intentId: "intent-1", sessionId: "session-1",
  });

  assert.deepEqual(result, { recorded: true });
  assert.equal(shard1.calls.some((call) => call.name === "billing_checkout_record_v1"), true);
  assert.equal(shard0.calls.some((call) => call.name === "billing_checkout_record_v1"), false);
});

test("billing authority rejects cached PostgreSQL", () => {
  assert.throws(
    () => new PostgresBillingRepository({ cacheMode: "cached" }, "shard-0"),
    (error) => error instanceof BillingControlError && error.code === "cached_authority_forbidden",
  );
});
