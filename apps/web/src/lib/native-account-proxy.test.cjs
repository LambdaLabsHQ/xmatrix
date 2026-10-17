const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const { nativeAccountPath } = require("./native-account-proxy.ts");

test("an app page's session reaches only its own account calls, nothing else on the Hub's auth surface", () => {
  for (const allowed of [["get-session"], ["two-factor", "verify-totp"], ["list-accounts"], ["link-social"],
    ["unlink-account"], ["sign-out"], ["oauth2", "get-consents"], ["oauth2", "delete-consent"]]) {
    assert.equal(nativeAccountPath(allowed), allowed.join("/"));
  }
  for (const refused of [["token"], ["revoke-sessions"], ["sign-in", "email"], ["passkey", "generate-register-options"],
    ["admin", "list-users"], ["two-factor", "..", "token"], ["oauth2", "authorize"], []]) {
    assert.equal(nativeAccountPath(refused), null, refused.join("/"));
  }
});
