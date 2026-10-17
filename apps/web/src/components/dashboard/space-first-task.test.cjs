const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  composeFirstTaskMessage,
  isXmatrixManagedWorkspacePath,
  spaceFirstTaskState,
} = require("./space-first-task.ts");

function agent(overrides = {}) {
  return { id: "agent-1", name: "claude-macbook", spaceId: "space-1", ...overrides };
}

function input(overrides = {}) {
  return {
    channelsLoaded: true,
    agentsLoaded: true,
    spaceId: "space-1",
    spaceAgents: [agent()],
    spaceChannelCount: 0,
    ...overrides,
  };
}

test("cached agents and an unfinished catalog cannot trigger the first task", () => {
  assert.deepEqual(spaceFirstTaskState(input({ channelsLoaded: false })), { kind: "hidden" });
  assert.deepEqual(spaceFirstTaskState(input({ agentsLoaded: false })), { kind: "hidden" });
  assert.equal(spaceFirstTaskState(input()).kind, "first-task");
});

test("a bound agent with no channel yet is given its first task", () => {
  const state = spaceFirstTaskState(input());
  assert.equal(state.kind, "first-task");
  assert.equal(state.agent.name, "claude-macbook");
});

test("nothing about the machine's registered directories reaches this state", () => {
  // The state carries only the agent: listing directories here would show one
  // organisation's repositories while the human works in another's Space.
  const state = spaceFirstTaskState(input());
  assert.deepEqual(Object.keys(state).sort(), ["agent", "kind"]);
});


test("guidance stops as soon as the Space has any channel", () => {
  assert.deepEqual(spaceFirstTaskState(input({ spaceChannelCount: 1 })), { kind: "hidden" });
});

test("a Space with no bound agent is left to the discovery card", () => {
  assert.deepEqual(spaceFirstTaskState(input({ spaceAgents: [] })), { kind: "hidden" });
});

test("an agent bound to another Space does not count", () => {
  const state = spaceFirstTaskState(
    input({ spaceAgents: [agent({ id: "agent-2", spaceId: "space-2" })] })
  );
  assert.deepEqual(state, { kind: "hidden" });
});

test("Auto can start with a bound Agent regardless of its display name", () => {
  const state = spaceFirstTaskState(
    input({ spaceAgents: [agent({ id: "agent-3", name: "claude macbook" })] })
  );
  assert.deepEqual(state, { kind: "first-task", agent: agent({ id: "agent-3", name: "claude macbook" }) });
});

test("no Space selected means nothing to guide", () => {
  assert.deepEqual(spaceFirstTaskState(input({ spaceId: null })), { kind: "hidden" });
});


test("xMatrix's own directories are recognised, a real project named xmatrix is not", () => {
  for (const managed of [
    "/Users/dev/.xmatrix/worktrees/abc123",
    "/Users/dev/.xmatrix-management/run-e0f65d6cb7ee",
    "/Users/dev/.config/xmatrix/repo-pools/abc123/slots/def456",
    "/Users/dev/.config/xmatrix/repo-pools/b43d69d6/abc123",
    "C:\\Users\\dev\\.config\\xmatrix\\repo-pools\\b43d69d6\\abc123",
  ]) {
    assert.equal(isXmatrixManagedWorkspacePath(managed), true, managed);
  }
  assert.equal(isXmatrixManagedWorkspacePath("/Users/dev/Projects/xmatrix"), false);
  assert.equal(isXmatrixManagedWorkspacePath("/Projects/repo-pools/my-repo/docs"), false);
  assert.equal(isXmatrixManagedWorkspacePath("/Projects/repo-pools/b43d69d6/abcdefg"), false);
});

test("the first message uses the current Auto syntax and the chosen directory", () => {
  assert.deepEqual(
    composeFirstTaskMessage({
      workspacePath: "/Users/dev/xmatrix-space",
      message: "Read the runbook and write notes.md",
    }),
    {
      ok: true,
      body: "@auto pwd:/Users/dev/xmatrix-space Read the runbook and write notes.md",
    }
  );
});

test("a path with whitespace stays one argument", () => {
  const composed = composeFirstTaskMessage({
    workspacePath: "/Users/dev/My Projects/demo",
    message: "Write notes.md",
  });
  assert.equal(composed.ok, true);
  assert.match(composed.body, /@auto pwd:"\/Users\/dev\/My Projects\/demo" Write notes\.md/u);
});

test("a Windows directory survives Auto composition and shared parsing", () => {
  const path = "C:\\Users\\dev\\My Projects\\demo";
  const composed = composeFirstTaskMessage({ workspacePath: path, message: "Review the files" });
  assert.equal(composed.ok, true);
  assert.equal(require("@xmatrix/protocol").parseAutoLaunchMentions(composed.body)[0].tags.pwd, path);
});

test("other mentions remain ordinary message syntax", () => {
  const composed = composeFirstTaskMessage({
    workspacePath: "/Users/dev/demo",
    message: "@someone-else do this @auto",
  });
  assert.deepEqual(composed, {
    ok: true, body: "@auto pwd:/Users/dev/demo @someone-else do this @auto",
  });
});

test("xMatrix's own directory is refused even if it reaches composition", () => {
  const composed = composeFirstTaskMessage({
    workspacePath: "/Users/dev/.xmatrix/worktrees/abc123",
    message: "Write notes.md",
  });
  assert.equal(composed.ok, false);
  assert.match(composed.reason, /xMatrix itself/u);
});

test("without a folder the first task goes to Auto, which works in its own folder", () => {
  // The browser and the phone have no folder picker; they need none to start.
  assert.deepEqual(composeFirstTaskMessage({ message: "Write a page about my project" }),
    { ok: true, body: "@auto Write a page about my project" });
  assert.deepEqual(composeFirstTaskMessage({ workspacePath: "  ", message: "Plan with me" }),
    { ok: true, body: "@auto Plan with me" });
});

test("an empty first task is not sent", () => {
  assert.equal(composeFirstTaskMessage({ workspacePath: "/Users/dev/demo", message: "  " }).ok, false);
});
