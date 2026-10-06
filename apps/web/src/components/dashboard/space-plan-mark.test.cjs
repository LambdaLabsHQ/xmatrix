const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { spacePlanMark } = require("./space-plan-mark.ts");

const FRESH_FREE = { acceptedMessages: 12, limit: 500, remaining: 488 };

test("an unknown plan carries no mark at all", () => {
  // Rendering Free while the read is in flight would assert an entitlement
  // nobody has read yet.
  for (const billing of [null, undefined, {}, { plan: "enterprise" }, { plan: "" }]) {
    assert.equal(spacePlanMark(billing), null);
  }
});

test("both plans are marked, and only Pro takes the brass", () => {
  assert.deepEqual(spacePlanMark({ plan: "pro", subscription: { status: "active", cancelAtPeriodEnd: false } }), {
    plan: "pro",
    label: "Pro",
    state: "active",
    title: "This Space is on Pro",
  });
  assert.deepEqual(spacePlanMark({ plan: "free", subscription: null, freeUsage: FRESH_FREE }), {
    plan: "free",
    label: "Free",
    state: "active",
    title: "Free — 488 of 500 messages left",
  });
});

test("a pro Space with no subscription record still marks active", () => {
  // Reconciliation lag: the plan is authoritative, the subscription detail is not.
  assert.equal(spacePlanMark({ plan: "pro" })?.state, "active");
  assert.equal(spacePlanMark({ plan: "pro", subscription: null })?.state, "active");
});

test("past due blocks, a pending cancellation only ends", () => {
  const pastDue = spacePlanMark({
    plan: "pro",
    subscription: { status: "past_due", cancelAtPeriodEnd: false, access: "read_only" },
  });
  assert.equal(pastDue?.state, "blocked");
  assert.match(pastDue?.title ?? "", /read-only/);

  const cancelling = spacePlanMark({
    plan: "pro",
    subscription: { status: "active", cancelAtPeriodEnd: true, access: "full" },
  });
  assert.equal(cancelling?.state, "ending");
  assert.equal(cancelling?.label, "Pro");
  assert.match(cancelling?.title ?? "", /cancels at the end/);
});

test("read-only outranks a pending cancellation", () => {
  // Both are true when a past-due subscription is also set to cancel; the
  // blocking one is the fact the reader needs.
  const mark = spacePlanMark({
    plan: "pro",
    subscription: { status: "past_due", cancelAtPeriodEnd: true, access: "read_only" },
  });
  assert.equal(mark?.state, "blocked");
});

test("a healthy subscription never reads as ending or blocked", () => {
  for (const status of ["active", "trialing"]) {
    const mark = spacePlanMark({ plan: "pro", subscription: { status, cancelAtPeriodEnd: false, access: "full" } });
    assert.equal(mark?.state, "active");
  }
});

test("an exhausted Free allowance blocks the Space and names the cap", () => {
  const mark = spacePlanMark({
    plan: "free",
    subscription: null,
    freeUsage: { acceptedMessages: 500, limit: 500, remaining: 0 },
  });
  assert.equal(mark?.state, "blocked");
  assert.equal(mark?.label, "Free");
  assert.match(mark?.title ?? "", /all 500 messages used/);
});

test("Pro ignores the Free counter it is also served", () => {
  // Every summary carries freeUsage, exhausted or not, whatever the plan.
  const mark = spacePlanMark({
    plan: "pro",
    subscription: { status: "active", cancelAtPeriodEnd: false, access: "full" },
    freeUsage: { acceptedMessages: 500, limit: 500, remaining: 0 },
  });
  assert.equal(mark?.state, "active");
});

test("a missing or malformed counter reads as unknown, not as exhausted", () => {
  for (const freeUsage of [undefined, null, {}, { remaining: null }, { remaining: "0" }, { remaining: NaN }]) {
    const mark = spacePlanMark({ plan: "free", subscription: null, freeUsage });
    assert.equal(mark?.state, "active");
    assert.equal(mark?.title, "This Space is on Free");
  }
});

test("a known remaining count with an unknown cap still reads", () => {
  const mark = spacePlanMark({ plan: "free", subscription: null, freeUsage: { remaining: 7 } });
  assert.equal(mark?.title, "This Space is on Free");

  const exhausted = spacePlanMark({ plan: "free", subscription: null, freeUsage: { remaining: 0 } });
  assert.equal(exhausted?.state, "blocked");
  assert.match(exhausted?.title ?? "", /allowance is used up/);
});

test("a 404 from Space billing means the deployment has no Space plans", () => {
  const { spacePlansAbsent } = require("./space-plan-mark.ts");
  const { XMatrixApiError } = require("../../lib/query/api-client.ts");
  assert.equal(spacePlansAbsent(new XMatrixApiError({ message: "Not Found", status: 404 })), true);
  assert.equal(spacePlansAbsent(new XMatrixApiError({ message: "Unavailable", status: 503 })), false);
  assert.equal(spacePlansAbsent(new Error("offline")), false);
  assert.equal(spacePlansAbsent(null), false);
});
