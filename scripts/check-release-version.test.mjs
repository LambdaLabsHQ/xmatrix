import { assert, test } from "./script-test-fixture.mjs";
import { checkReleaseVersion } from "./check-release-version.mjs";

const env = { GITHUB_REF_NAME: "xmatrix-v1.2.3", GITHUB_SHA: "a".repeat(40), XMATRIX_RELEASE_BASE_REF: "base" };
const expectedChecks = [
  ["scripts/version.mjs", "check"],
  ["scripts/production-release-policy.mjs", "verify-remote-tag", env.GITHUB_REF_NAME, env.GITHUB_SHA],
  ["scripts/version.mjs", "check-release-order", "--require-new-version"],
];

test("release checks preserve immutable-tag proof between consistency and version-floor checks", () => {
  const calls = [];
  assert.equal(checkReleaseVersion({ env, run: (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(options, { env, stdio: "inherit" });
    calls.push(args);
    return { status: 0 };
  } }), 0);
  assert.deepEqual(calls, expectedChecks);
});

test("a failed tag proof stops release checks and preserves its exit status", () => {
  const calls = [];
  const status = checkReleaseVersion({ env, run: (_command, args) => {
    calls.push(args);
    return { status: calls.length === 2 ? 7 : 0 };
  } });
  assert.equal(status, 7);
  assert.deepEqual(calls, expectedChecks.slice(0, 2));
});

