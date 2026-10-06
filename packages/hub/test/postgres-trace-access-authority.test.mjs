import assert from "node:assert/strict";
import test from "node:test";
import { PostgresTraceAccessRepository } from "@xmatrix/db";

import { recordingDatabase } from "./support/postgres-database.mjs";

test("a trace authorization batch decides every check in one read", async () => {
  const calls = [];
  const database = recordingDatabase((query) => {
    if (query.name === "trace_access_instance_v2") return [{ owner_user_id: "owner-1",
      agent_id: "agent-1", channel_id: "channel-1", instance_status: "online",
      run_status: "running" }];
    if (query.name === "trace_access_authorize_checks_v4") return [{ ordinality: 1, allowed: true }];
    return [];
  }, calls);
  const result = await new PostgresTraceAccessRepository(database).authorizeBatch({ instanceId: "instance-1",
    checks: [{ userId: "owner-1", channelId: "channel-1" }] });
  assert.deepEqual(result.decisions, [{ userId: "owner-1", channelId: "channel-1", allowed: true }]);
  assert.equal(calls.some((call) => call.name === "trace_access_authorize_checks_v4"), true);
});
