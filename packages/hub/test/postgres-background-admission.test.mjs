import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionStripe, BackgroundAdmission, backgroundAdmissionBudget,
} from "../src/postgres-background-admission.ts";

test("a million Channels get the same shard-wide bound", () => {
  const budget = backgroundAdmissionBudget({});
  const stripes = Array.from({ length: budget.stripes },
    () => new BackgroundAdmission(budget.stripeLimit, budget.stripeMaintenanceLimit));
  let granted = 0;
  for (let index = 0; index < 1_000_000; index++) {
    const channelId = `channel-${index}`;
    if (stripes[admissionStripe(channelId, budget.stripes)].acquire(channelId, "interactive", 0).granted) granted++;
  }
  assert.equal(granted, budget.stripes * budget.stripeLimit);
  assert.ok(granted <= 8);
});

test("maintenance passes never take the whole budget from interactive ones", () => {
  const admission = new BackgroundAdmission(2, 1, 30_000);
  assert.equal(admission.acquire("retry-a", "maintenance", 0).granted, true);
  assert.equal(admission.acquire("retry-b", "maintenance", 0).granted, false);
  assert.equal(admission.acquire("summon", "interactive", 0).granted, true);
  assert.equal(admission.acquire("summon-2", "interactive", 0).granted, false);
});

test("a released or lapsed permit admits the next pass, never with an immediate retry", () => {
  const admission = new BackgroundAdmission(1, 1, 30_000);
  assert.equal(admission.acquire("a", "maintenance", 0).granted, true);
  assert.deepEqual(admission.acquire("b", "maintenance", 29_900), { granted: false, retryAfterMs: 500 });
  admission.release("a");
  assert.equal(admission.acquire("b", "maintenance", 29_900).granted, true);
  // A holder lost mid-pass cannot keep its permit past the lease.
  assert.equal(admission.acquire("c", "interactive", 59_900).granted, true);
});

test("a Channel always asks the same stripe, and the budget is bounded", () => {
  assert.equal(admissionStripe("channel-x", 4), admissionStripe("channel-x", 4));
  assert.deepEqual(backgroundAdmissionBudget({}), { stripes: 4, stripeLimit: 2, stripeMaintenanceLimit: 1 });
  assert.deepEqual(backgroundAdmissionBudget({ POSTGRES_BACKGROUND_PASS_LIMIT: "2", POSTGRES_BACKGROUND_ADMISSION_STRIPES: "8" }),
    { stripes: 2, stripeLimit: 1, stripeMaintenanceLimit: 1 });
  assert.equal(backgroundAdmissionBudget({ POSTGRES_BACKGROUND_PASS_LIMIT: "0" }).stripes, 4);
});
