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

test("what leaves the machine has no home, email, token or query", async () => {
  const { redactDaemonDetail } = await import("./daemon-failure.ts");
  const detail = redactDaemonDetail([
    "starting",
    "Error: cannot open /Users/ada/Library/Application Support/xmatrix/daemon.lock: Permission denied",
    "user ada@example.com token=abc123def",
    "GET https://xmatrix-hub.xmatrix.sh/api/auth/refresh?code=s3cret failed",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload",
    "/Users/bob/bin/xmatrix exited",
  ].join("\n"), "/Users/ada");
  assert.match(detail, /cannot open ~\/Library\/Application Support\/xmatrix\/daemon\.lock: Permission denied/);
  assert.doesNotMatch(detail, /ada|bob|abc123def|s3cret|eyJhbGci/);
  assert.match(detail, /<email>/);
  assert.match(detail, /\/Users\/…\/bin\/xmatrix exited/);
});

test("only the last lines leave, bounded", async () => {
  const { redactDaemonDetail } = await import("./daemon-failure.ts");
  const detail = redactDaemonDetail(Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n"), "/Users/ada");
  assert.equal(detail.split("\n").length, 8);
  assert.match(detail, /line 49/);
  assert.ok(redactDaemonDetail("y ".repeat(2000), "").length <= 600);
});
