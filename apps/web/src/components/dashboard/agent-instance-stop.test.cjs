const assert = require("node:assert/strict");
const test = require("node:test");

async function load() {
  return await import("./agent-instance-stop.ts");
}

test("stop addresses the Channel ordinal by name, never by an internal id", async () => {
  const { agentInstanceStopBody } = await load();
  assert.equal(agentInstanceStopBody({ id: "instance:e3284238-170b-4a3a-b83c-d6bc07907367", name: "codex" },
    { label: "codex:3", channelInstanceId: "3" }), "@codex:3:stop");
});

test("stop uses the Instance card address when live agent_list is empty", async () => {
  const { agentInstanceStopBody } = await load();
  assert.equal(
    agentInstanceStopBody(undefined, {
      label: "grok:1",
      channelInstanceId: "1",
    }),
    "@grok:1:stop",
  );
});

test("stop prefers the card label over a missing catalog name", async () => {
  const { agentInstanceStopBody } = await load();
  assert.equal(
    agentInstanceStopBody(
      { name: "" },
      { label: "Codex:2", channelInstanceId: "2" },
      "ignored-when-label-has-the-slot",
    ),
    "@Codex:2:stop",
  );
});

test("stop falls back to the presence label when the card has no address label", async () => {
  const { agentInstanceStopBody } = await load();
  assert.equal(
    agentInstanceStopBody(
      undefined,
      { channelInstanceId: "3" },
      "grok",
    ),
    "@grok:3:stop",
  );
});

test("stop has no command for the reserved xMatrix name", async () => {
  const { agentInstanceStopBody } = await load();
  assert.equal(
    agentInstanceStopBody(undefined, { label: "xMatrix:1", channelInstanceId: "1" }),
    null,
  );
});

test("stop refuses a card that has no channel ordinal", async () => {
  const { agentInstanceStopBody } = await load();
  assert.equal(
    agentInstanceStopBody({ name: "grok" }, { label: "grok" }),
    null,
  );
});
