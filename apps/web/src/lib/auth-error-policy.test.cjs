const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { classifyAuthClientFailure } = require("./auth-error-policy.ts");

test("auth client failure policy keeps user rejection separate from infrastructure failure", () => {
  assert.equal(classifyAuthClientFailure({ status: 400 }), "rejected");
  assert.equal(classifyAuthClientFailure({ status: 401 }), "rejected");
  assert.equal(classifyAuthClientFailure({ status: 408 }), "transient");
  assert.equal(classifyAuthClientFailure({ status: 429 }), "transient");
  assert.equal(classifyAuthClientFailure({ status: 500 }), "transient");
  assert.equal(classifyAuthClientFailure({ networkFailure: true }), "transient");
});

test("auth client failure policy gives email configuration its stable meaning", () => {
  assert.equal(
    classifyAuthClientFailure({ status: 503, emailConfiguration: true }),
    "email_configuration",
  );
});
