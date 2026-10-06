import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveTestEnvironmentAccess } from "../src/test-environment-access.ts";

test("Test access is pinned to one bounded deployment Space id", async () => {
  const calls = [];
  const probe = async (spaceId) => {
    calls.push(spaceId);
    return true;
  };
  const member = { id: "member:1" };
  for (const unset of [{}, { TEST_ENVIRONMENT_ACCESS_SPACE_ID: "  " }, { TEST_ENVIRONMENT_ACCESS_SPACE_ID: "x".repeat(181) }]) {
    assert.equal(await resolveTestEnvironmentAccess(member, unset, probe), false);
  }
  assert.equal(await resolveTestEnvironmentAccess(member, { TEST_ENVIRONMENT_ACCESS_SPACE_ID: " lambda-labs " }, probe), true);
  assert.deepEqual(calls, ["lambda-labs"]);
});

test("only a human member of the configured Lambda Labs Space receives Test access", async () => {
  const calls = [];
  const probe = async (spaceId, userId) => {
    calls.push({ spaceId, userId });
    return spaceId === "lambda-labs" && userId === "member:1";
  };
  const env = { TEST_ENVIRONMENT_ACCESS_SPACE_ID: "lambda-labs" };

  assert.equal(await resolveTestEnvironmentAccess({ id: "member:1" }, env, probe), true);
  assert.equal(await resolveTestEnvironmentAccess({ id: "outsider:1" }, env, probe), false);
  assert.deepEqual(calls, [
    { spaceId: "lambda-labs", userId: "member:1" },
    { spaceId: "lambda-labs", userId: "outsider:1" },
  ]);
});

test("missing config and delegated Agent Runs fail closed without probing membership", async () => {
  const calls = [];
  const probe = async (...args) => {
    calls.push(args);
    return true;
  };

  assert.equal(await resolveTestEnvironmentAccess({ id: "member:1" }, {}, probe), false);
  assert.equal(await resolveTestEnvironmentAccess(
    { id: "member:1", agentRun: { ownerUserId: "member:1" } },
    { TEST_ENVIRONMENT_ACCESS_SPACE_ID: "lambda-labs" },
    probe,
  ), false);
  assert.deepEqual(calls, []);
});
