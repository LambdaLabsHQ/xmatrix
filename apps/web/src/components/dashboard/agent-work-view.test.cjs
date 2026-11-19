const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { createAgentWorkSelection, NO_BUSY_INSTANCES, withBusyInstance } = require("./agent-work-view.ts");

/** claude:1 at work, waiting on `count` background tasks it started. */
function waitingOnTasks(count) {
  return {
    key: "instance-claude-1", agentId: "agent:claude", label: "claude:1", agentLabel: "claude",
    face: { kind: "agent", name: "claude", harness: "claude", id: "instance-claude-1" },
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

test("a second Instance can be stopped while the first stop is still being sent", () => {
  const first = withBusyInstance(NO_BUSY_INSTANCES, "instance-claude-1", true);
  // The first request holds only its own Instance.
  assert.equal(first.has("instance-claude-1"), true);
  assert.equal(first.has("instance-codex-1"), false);
  const both = withBusyInstance(first, "instance-codex-1", true);
  assert.deepEqual([...both].sort(), ["instance-claude-1", "instance-codex-1"]);
  // The first finishing leaves the second still marked as being sent.
  const second = withBusyInstance(both, "instance-claude-1", false);
  assert.deepEqual([...second], ["instance-codex-1"]);
  assert.equal(withBusyInstance(second, "instance-codex-1", true), second);
  assert.equal(withBusyInstance(second, "instance-codex-1", false), NO_BUSY_INSTANCES);
});
