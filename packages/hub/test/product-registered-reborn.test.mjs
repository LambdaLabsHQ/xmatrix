import assert from "node:assert/strict";
import test from "node:test";
import {
  orchestrateProductAgentMentions,
} from "../src/product-agent-mention.ts";

const target = { instanceId: "instance-2", instanceStatus: "offline", channelId: "channel", channelInstanceId: 2,
  runId: "run:old", runStatus: "stopped", agentName: "codex", addressName: "codex",
  ownerUserId: "owner", metadata: {} };

function port(overrides) {
  const calls = [];
  return { calls, port: new Proxy({
    getRebornTarget: async () => ({ ...target }),
    publishSystemNotice: async value => { calls.push(["notice", value.body]); },
    ...overrides,
  }, { get(object, name) {
    if (name in object) return object[name];
    return async () => { calls.push(["legacy", String(name)]); throw new Error(`legacy path reached: ${String(name)}`); };
  } }) };
}

const input = (port) => ({ channelId: "channel", messageId: "message", body: "@codex:2:reborn keep going",
  actorUserId: "owner", port });

test("in a composite Space @name:N:reborn queues a registered reborn and never a Profile summon", async () => {
  const requests = [];
  const { calls, port: fake } = port({ prepareRegisteredReborn: async value => {
    requests.push(value); return { mode: "composite", intentId: "run:reborn:x", state: "waiting" };
  } });
  const result = await orchestrateProductAgentMentions(input(fake));
  assert.equal(result.spawned, 1);
  assert.deepEqual(requests, [{ channelId: "channel", sourceInstanceId: "instance-2", sourceMessageId: "message",
    sourceMention: "@codex:2:reborn", prompt: "keep going" }]);
  assert.deepEqual(calls.filter(call => call[0] === "legacy"), []);
});

test("a registered reborn failure is reported without falling back to a Profile summon", async () => {
  const { calls, port: fake } = port({ prepareRegisteredReborn: async () => { throw new Error("private detail"); } });
  const result = await orchestrateProductAgentMentions(input(fake));
  assert.equal(result.spawned, 0);
  assert.match(result.notices.join("\n"), /registration_reborn_failed/);
  assert.doesNotMatch(result.notices.join("\n"), /private detail/);
  assert.deepEqual(calls.filter(call => call[0] === "legacy"), []);
});
