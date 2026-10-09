import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAppRepository } from "@xmatrix/db";

import { resolveGitHubSubscriptionRoutes } from "../src/github-subscription-route-directory.ts";

// App relations are written only to the directory shard; every delivery used
// to ask each Space shard as well, an empty read (2026-10-09).
test("a delivery's routes are one read of the directory, however many shards there are", async (t) => {
  const reads = [];
  t.mock.method(PostgresAppRepository.prototype, "githubSubscriptionRoutes", async (input) => {
    reads.push(input);
    return [];
  });
  const routes = await resolveGitHubSubscriptionRoutes({
    RELAY_POSTGRES: { connectionString: "postgres://directory.invalid/xmatrix" },
    RELAY_POSTGRES_SHARD_ID: "shard-0",
    RELAY_POSTGRES_SHARD_1: { connectionString: "postgres://shard-1.invalid/xmatrix" },
    RELAY_POSTGRES_SHARD_1_ID: "shard-1",
  }, "installation-1", ["owner/repo"], "checks");
  assert.deepEqual(routes, []);
  assert.equal(reads.length, 1);
  assert.deepEqual([reads[0].installationId, reads[0].sourceRefs, reads[0].feature], ["installation-1", ["owner/repo"], "checks"]);
});
