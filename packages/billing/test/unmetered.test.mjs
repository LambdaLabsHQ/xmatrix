import assert from "node:assert/strict";
import { test } from "node:test";

import { spaceBilling } from "../dist/index.js";

test("by default nothing is metered and no billing table is read", async () => {
  const tx = { async query() { throw new Error("the default policy reads nothing"); } };
  const input = { spaceId: "space-1", now: "2026-10-02T12:00:00.000Z" };
  await spaceBilling.spaceCreated(tx, input);
  assert.equal(await spaceBilling.spaceDeletion(tx, input), null);
  assert.equal(await spaceBilling.seatAdmission(tx, input), null);
  assert.equal(spaceBilling.message.accepts, "TRUE");
  assert.doesNotMatch(spaceBilling.message.ctes, /billing/u);
  assert.equal(spaceBilling.message.rejection({}, input), null);
});
