import assert from "node:assert/strict";
import test from "node:test";
import { PostgresAppRepository } from "@xmatrix/db";

import { resolveGitHubSubscriptionRoutes } from "../src/github-subscription-route-directory.ts";

const shards = {
  RELAY_POSTGRES: { connectionString: "postgres://directory.invalid/xmatrix" },
  RELAY_POSTGRES_SHARD_ID: "shard-0",
  RELAY_POSTGRES_SHARD_1: { connectionString: "postgres://shard-1.invalid/xmatrix" },
  RELAY_POSTGRES_SHARD_1_ID: "shard-1",
};

function routeReads(t) {
  const reads = [];
  t.mock.method(PostgresAppRepository.prototype, "githubSubscriptionRoutes", async (input) => {
    reads.push(input);
    return [];
  });
  return reads;
}

// App relations are written only to the directory shard; every delivery used
// to ask each Space shard as well, an empty read (2026-10-09).
test("a delivery's routes are one read of the directory, however many shards there are", async (t) => {
  const reads = routeReads(t);
  const routes = await resolveGitHubSubscriptionRoutes(shards, "installation-1", ["owner/repo"], "checks");
  assert.deepEqual(routes, []);
  assert.equal(reads.length, 1);
  assert.deepEqual([reads[0].installationId, reads[0].sourceRefs, reads[0].feature], ["installation-1", ["owner/repo"], "checks"]);
});

test("a delivery the installation's index says nobody subscribed to reads no routes", async (t) => {
  const reads = routeReads(t);
  const asked = [];
  const index = (answer) => ({ idFromName: (name) => name, get: (id) => ({ mayRoute: async (...input) => {
    asked.push([id, ...input]);
    return answer();
  } }) });
  assert.deepEqual(await resolveGitHubSubscriptionRoutes({ ...shards, GITHUB_SUBSCRIPTION_INDEX: index(() => false) },
    "installation-1", ["owner/repo"], "checks"), []);
  assert.deepEqual(asked, [["installation-1", "installation-1", ["owner/repo"], "checks"]]);
  assert.equal(reads.length, 0);
  await resolveGitHubSubscriptionRoutes({ ...shards, GITHUB_SUBSCRIPTION_INDEX: index(() => true) },
    "installation-1", ["owner/repo"], "checks");
  assert.equal(reads.length, 1);
  await resolveGitHubSubscriptionRoutes({ ...shards, GITHUB_SUBSCRIPTION_INDEX: index(() => {
    throw new Error("index reset by a deploy");
  }) }, "installation-1", ["owner/repo"], "checks");
  assert.equal(reads.length, 2, "an index that cannot answer leaves the delivery to the exact read");
});
