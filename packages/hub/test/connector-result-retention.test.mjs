import assert from "node:assert/strict";
import { test } from "node:test";
import { appResultRetentionNotice } from "@xmatrix/protocol";
import { expireRetainedAppResults, RETAINED_APP_RESULTS } from "../src/connectors/result-retention.ts";

test("Google Cloud results are retained 29 days, inside the terms' 30", () => {
  assert.deepEqual([...RETAINED_APP_RESULTS], [["gcp", 29]]);
  assert.match(appResultRetentionNotice("gcp"), /deleted after 29 days.*disconnected.*do not copy it into Pages, memory/);
  assert.equal(appResultRetentionNotice("slack"), undefined);
});

test("an Agent listing Google Cloud's commands is told how long its results last", async () => {
  const { usageOf } = await import("../src/connectors/usage.ts");
  const [gcp] = usageOf(new Set(["gcp"]));
  assert.ok(gcp.actions.length > 0);
  for (const action of gcp.actions) assert.match(action.description, /deleted after 29 days/);
  const callable = gcp.actions.find((action) => action.via === "call" && action.effect === "read");
  assert.match(callable.description, /Human owner in the Web for 29 days/);
  const [slack] = usageOf(new Set(["slack"]));
  assert.ok(slack.actions.every((action) => !/deleted after/.test(action.description)));
});

test("a retention pass keeps expiring full batches, then reports the next due time", async () => {
  const calls = [];
  let remaining = 120;
  const content = {
    async expireAppResults(input) {
      calls.push(input);
      const messages = Math.min(input.limit, remaining);
      remaining -= messages;
      return { messages, executions: 0, refs: 0, cutoff: "" };
    },
    async nextAppResultsExpiry(input) { assert.equal(input.retentionDays, 29); return 1_000; },
  };
  const result = await expireRetainedAppResults(content, "space-1", new Map([["gcp", 29]]));
  assert.deepEqual(result, { expired: { gcp: 120 }, next: 1_000 });
  assert.deepEqual(calls.map((call) => [call.spaceId, call.appId, call.retentionDays, call.limit]),
    [["space-1", "gcp", 29, 50], ["space-1", "gcp", 29, 50], ["space-1", "gcp", 29, 50]]);
});
