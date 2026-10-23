const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();

const {
  deviceClientLabel,
  deviceProductName,
  nativeAppLabel,
  nativeLoginReturnUrl,
  normalizeNativeLoginClient,
} = require("./native-login-client.ts");

test("Android is preserved from either native context field", () => {
  assert.equal(normalizeNativeLoginClient("android", "unknown"), "android");
  assert.equal(normalizeNativeLoginClient("unknown", "android"), "android");
  assert.equal(normalizeNativeLoginClient("ios", "android"), "android");
});

test("native login labels distinguish Android from desktop and CLI", () => {
  assert.equal(deviceClientLabel("android"), "Android app");
  assert.equal(nativeAppLabel("android"), "Android app");
  assert.equal(deviceProductName("android"), "xMatrix Android");
  assert.equal(deviceClientLabel(null), "terminal");
});

test("an app's browser login returns through the registered app scheme; a terminal's does not", () => {
  assert.equal(nativeLoginReturnUrl("android"), "xmatrix://login");
  assert.equal(nativeLoginReturnUrl("ios"), "xmatrix://login");
  assert.equal(nativeLoginReturnUrl("desktop"), "xmatrix://login");
  assert.equal(nativeLoginReturnUrl(null), null);
});
