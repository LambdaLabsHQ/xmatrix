import assert from "node:assert/strict";
import test from "node:test";
import { requireAgentChannelAccess } from "../dist/index.js";

const reached = new Error("reached registration admission");

function fakeTx(rows) {
  const calls = [];
  return { calls, query: async query => {
    calls.push(query);
    if (query.name === "run_registration_access_binding_v3") throw reached;
    return rows[query.name] ?? [];
  } };
}

const input = { spaceId: "space", channelId: "channel", agentId: "instance", capability: "content_history_read",
  runProof: { runId: "run", instanceId: "instance", executionKey: "execution" } };
const liveRun = { owner_user_id: "owner", channel_id: "channel", instance_channel_id: "channel", status: "running",
  metadata_json: { executionKey: "execution", identityKind: "instance" } };

test("a Run reaches its registration admission as its Instance", async () => {
  const tx = fakeTx({ agent_channel_registered_run_access_v2: [liveRun] });
  await assert.rejects(() => requireAgentChannelAccess(tx, input), error => error === reached);
  const registered = tx.calls.find(call => call.name === "agent_channel_registered_run_access_v2");
  assert.deepEqual(registered.values, ["run", "instance", "space", "instance"]);
});

test("a Run without a registration binding is forbidden", async () => {
  await assert.rejects(() => requireAgentChannelAccess(fakeTx({}), input), error => error.code === "agent_run_forbidden");
});
