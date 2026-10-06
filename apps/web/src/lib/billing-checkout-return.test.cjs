const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { billingCheckoutReturn } = require("./billing-checkout-return.ts");
const parse = (query) => billingCheckoutReturn(new URLSearchParams(query));

test("AI success and cancellation never enter Space reconciliation", () => {
  for (const notice of ["success", "cancelled"]) {
    const result = parse(`ai_checkout=${notice}&ai_checkout_session_id=cs_live_AI`);
    assert.equal(result.spaceNotice, null);
    assert.equal(result.spaceSessionId, undefined);
  }
});

test("mixed, empty and malformed AI hints fail closed for Space", () => {
  for (const query of ["ai_checkout=success", "ai_checkout=", "ai_checkout=unknown", "ai_checkout_session_id=invalid"]) {
    const result = parse(`${query}&checkout=success&checkout_session_id=cs_live_AI`);
    assert.equal(result.spaceNotice, null);
    assert.equal(result.spaceSessionId, undefined);
  }
});

test("existing Space returns retain their validated session", () => {
  const result = parse("checkout=success&checkout_session_id=cs_live_Space123");
  assert.equal(result.spaceNotice, "success");
  assert.equal(result.spaceSessionId, "cs_live_Space123");
  assert.equal(parse("checkout_session_id=untrusted").spaceSessionId, undefined);
  assert.equal(parse("checkout=cancelled").spaceNotice, "cancelled");
});
