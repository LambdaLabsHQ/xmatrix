const assert = require("node:assert/strict");
const test = require("node:test");

let daemonFailureNeedsLogin;

test.before(async () => {
  ({ daemonFailureNeedsLogin } = await import("./daemon-failure.ts"));
});

test("a refused session needs a sign-in", () => {
  assert.equal(daemonFailureNeedsLogin("Session refresh failed: Invalid refresh token"), true);
  assert.equal(daemonFailureNeedsLogin("Session refresh failed: refresh token already used"), true);
  assert.equal(daemonFailureNeedsLogin("Not logged in. Run xmatrix login."), true);
  assert.equal(daemonFailureNeedsLogin("Session expired"), true);
});

test("an outage during refresh keeps the daemon restarting", () => {
  for (const output of [
    "Session refresh failed: Authentication service is temporarily unavailable.",
    "Session refresh failed: error sending request for url (https://xmatrix-hub.xmatrix.sh/api/auth/refresh)",
    "Session refresh failed: operation timed out",
    "Session refresh failed: PostgreSQL is unavailable",
  ]) assert.equal(daemonFailureNeedsLogin(output), false, output);
});

test("an unrelated exit is not a sign-in", () => {
  assert.equal(daemonFailureNeedsLogin("xMatrix daemon exited with code 1."), false);
});
