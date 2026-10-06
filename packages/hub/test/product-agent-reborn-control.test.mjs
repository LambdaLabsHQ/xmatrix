import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentRebornControlBody,
  requestOwnedInstanceReborn,
} from "../src/product-agent-reborn-control.ts";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture() {
  const instance = { channelId: "channel", instanceId: "instance", runId: "run:old", channelInstanceId: 2 };
  const reborns = [];
  const input = { actorUserId: "owner", channelId: "channel", instanceId: "instance", expectedRunId: "run:old",
    requestId, sourceMessageId: "instance-reborn:stable", instance, port: {
      prepareRegisteredReborn: async (reborn) => { reborns.push(reborn); return { intentId: "intent", state: "waiting" }; },
      publishSystemNotice: async () => assert.fail("control requests cannot post messages"),
    } };
  return { input, instance, reborns };
}

test("owner recovery is an exact, stable registration reborn without a Channel message", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) assert.deepEqual(await requestOwnedInstanceReborn(f.input),
    { requestId, instanceId: "instance", state: "queued" });
  assert.equal(f.reborns.length, 2);
  assert.equal(f.reborns[0].sourceMessageId, f.reborns[1].sourceMessageId);
  assert.equal(f.reborns[0].sourceInstanceId, "instance");
});

test("cross-Channel and stale Run controls never reach the reborn", async () => {
  for (const [field, value] of [["channelId", "other"], ["instanceId", "other"], ["runId", "run:new"]]) {
    const f = fixture(); f.instance[field] = value;
    await assert.rejects(requestOwnedInstanceReborn(f.input), error => error.code === "reborn_source_changed");
    assert.equal(f.reborns.length, 0);
  }
});

test("a refused registration reborn keeps its code", async () => {
  const f = fixture();
  f.input.port.prepareRegisteredReborn = async () => {
    throw Object.assign(new Error("refused"), { code: "registration_reborn_unregistered" });
  };
  await assert.rejects(requestOwnedInstanceReborn(f.input), error => error.code === "registration_reborn_unregistered");
});

test("the body accepts only an exact expected Run and canonical request identity", () => {
  assert.deepEqual(parseAgentRebornControlBody({ requestId, expectedRunId: "run:old" }), { requestId, expectedRunId: "run:old" });
  assert.deepEqual(parseAgentRebornControlBody({ requestId, expectedRunId: "ch-1:3#2" }), { requestId, expectedRunId: "ch-1:3#2" },
    "a natural Run id is an exact Run");
  for (const value of [null, [], {}, { requestId, expectedRunId: "run:old", body: "injected task" },
    { requestId, expectedRunId: "ch-1:3" }, { requestId, expectedRunId: "ch-1:3#0" },
    { requestId: "reuse", expectedRunId: "run:old" }, { requestId, expectedRunId: "run:old\n" }]) {
    assert.throws(() => parseAgentRebornControlBody(value), error => error.status === 400);
  }
});
