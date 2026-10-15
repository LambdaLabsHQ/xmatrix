const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { createAgentWorkSelection } = require("./agent-work-view.ts");

/** claude:1 at work, waiting on `count` background tasks it started. */
function waitingOnTasks(count) {
  return {
    key: "instance-claude-1", agentId: "agent:claude", label: "claude:1", agentLabel: "claude", avatarKind: "agent",
    status: "busy", canStop: true,
    instance: {
      id: "instance-claude-1", channelInstanceId: "1", label: "claude:1", status: "busy",
      runtimeState: { status: "running", waiting: { kind: "background", count, sinceMillis: 1_000 } },
    },
  };
}

test("the dock follows the number of background tasks still running", () => {
  let items = [waitingOnTasks(2)];
  const select = createAgentWorkSelection(() => items);
  const first = select({ id: "channel-1" });
  assert.equal(first[0].waiting?.count, 2);
  // The same report again keeps the views the dock already drew.
  assert.equal(select({ id: "channel-2" }), first);
  items = [waitingOnTasks(3)];
  assert.equal(select({ id: "channel-3" })[0].waiting?.count, 3);
});
