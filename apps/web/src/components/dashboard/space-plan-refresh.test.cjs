const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const {
  spacePlanMarkSignature,
  spacePlanNoticeNeedsFetch,
  spacePlanRefreshToPublish,
} = require("./space-plan-refresh.ts");

const FREE_EXHAUSTED = {
  plan: "free",
  subscription: null,
  freeUsage: { acceptedMessages: 500, limit: 500, remaining: 0 },
};
const PRO = {
  plan: "pro",
  subscription: { status: "active", cancelAtPeriodEnd: false, access: "full" },
  freeUsage: { acceptedMessages: 500, limit: 500, remaining: 0 },
};

test("the mark signature follows what the chip paints, not the rest of the summary", () => {
  assert.equal(spacePlanMarkSignature(null), null);
  assert.equal(spacePlanMarkSignature(undefined), null);
  const exhausted = spacePlanMarkSignature(FREE_EXHAUSTED);
  const pro = spacePlanMarkSignature(PRO);
  assert.equal(exhausted, "free|blocked|Free — all 500 messages used, this Space cannot send until it upgrades");
  assert.equal(pro, "pro|active|This Space is on Pro");
  assert.notEqual(exhausted, pro);
  assert.equal(spacePlanMarkSignature({ ...PRO, seats: { used: 1, limit: 1 } }), pro);
});

test("the first time a tab learns a plan, it does not announce it", () => {
  const pro = spacePlanMarkSignature(PRO);
  assert.equal(spacePlanRefreshToPublish(undefined, pro), null);
  assert.equal(spacePlanRefreshToPublish(null, pro), null);
  assert.equal(spacePlanRefreshToPublish(undefined, null), null);
});

test("a later change is announced once, and the same mark is not announced again", () => {
  const exhausted = spacePlanMarkSignature(FREE_EXHAUSTED);
  const pro = spacePlanMarkSignature(PRO);
  assert.equal(spacePlanRefreshToPublish(exhausted, pro), pro);
  assert.equal(spacePlanRefreshToPublish(pro, pro), null);
  assert.equal(spacePlanRefreshToPublish(pro, null), null);
});

test("a tab refetches only a notice for its own space whose mark it does not already show", () => {
  const local = {
    userId: "user-1",
    spaceId: "space-1",
    signature: spacePlanMarkSignature(FREE_EXHAUSTED),
  };
  const pro = spacePlanMarkSignature(PRO);
  assert.equal(spacePlanNoticeNeedsFetch({ userId: "user-1", spaceId: "space-1", signature: pro }, local), true);
  assert.equal(spacePlanNoticeNeedsFetch({ userId: "user-1", spaceId: "space-1", signature: local.signature }, local), false);
  assert.equal(spacePlanNoticeNeedsFetch({ userId: "user-1", spaceId: "space-2", signature: pro }, local), false);
  assert.equal(spacePlanNoticeNeedsFetch({ userId: "user-2", spaceId: "space-1", signature: pro }, local), false);
  assert.equal(spacePlanNoticeNeedsFetch(null, local), false);
  assert.equal(spacePlanNoticeNeedsFetch({ userId: "user-1", spaceId: "space-1", signature: "" }, local), false);
});
