const assert = require("node:assert/strict");
const test = require("node:test");

let clientEnvironmentForHostname;
let clientAppUrl;

test.before(async () => {
  const loaded = await import("./client-environment.ts");
  clientEnvironmentForHostname = loaded.clientEnvironmentForHostname;
  clientAppUrl = loaded.clientAppUrl;
});

test("uses the environment root when switching from inside the app", () => {
  assert.equal(clientAppUrl("production"), "https://xmatrix.sh/app");
  assert.equal(clientAppUrl("test"), "https://test.xmatrix.sh/app");
});

test("recognizes only the exact hosted test application", () => {
  assert.equal(clientEnvironmentForHostname("test.xmatrix.sh"), "test");
  assert.equal(clientEnvironmentForHostname("TEST.XMATRIX.SH"), "test");
  assert.equal(clientEnvironmentForHostname("xmatrix.sh"), "production");
  assert.equal(clientEnvironmentForHostname("evil.test.xmatrix.sh"), "production");
});
