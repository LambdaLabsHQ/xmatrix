const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { sessionNotReadyMessage } = require("./session-not-ready.ts");

test("XMATRIX-WEB-12: a session that stays unread names the gap and how many reads were tried", () => {
  const empty = sessionNotReadyMessage("empty_user", 4);
  const missing = sessionNotReadyMessage("missing_jwt", 1);
  const failed = sessionNotReadyMessage("error", 2, "MissingAuthJwtError");
  assert.match(empty, /gap=empty_user attempts=4$/u);
  assert.match(missing, /gap=missing_jwt attempts=1$/u);
  assert.match(failed, /gap=error name=MissingAuthJwtError attempts=2$/u);
  assert.equal(empty.includes("name="), false);
  assert.equal(sessionNotReadyMessage("error", 2, "user@example.com").includes("@"), false);
  assert.equal(sessionNotReadyMessage("error", 2, "Error: token abc").includes("token"), false);
});
