const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  composeFirstTaskMessage,
  isXmatrixManagedWorkspacePath,
  spaceFirstTaskState,
  suggestedSpaceFolderName,
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
    folderPickerAvailable: true,
    ...overrides,
  };
}

test("cached agents and an unfinished catalog cannot trigger the first task", () => {
  assert.deepEqual(spaceFirstTaskState(input({ channelsLoaded: false })), { kind: "hidden" });
  assert.deepEqual(spaceFirstTaskState(input({ agentsLoaded: false })), { kind: "hidden" });
  assert.equal(spaceFirstTaskState(input()).kind, "needs-workspace");
});

test("a bound agent with no channel yet is asked for a folder", () => {
  const state = spaceFirstTaskState(input());
  assert.equal(state.kind, "needs-workspace");
  assert.equal(state.agent.name, "claude-macbook");
});

test("nothing about the machine's registered directories reaches this state", () => {
  // The state carries only the agent: listing directories here would show one
  // organisation's repositories while the human works in another's Space.
  const state = spaceFirstTaskState(input());
  assert.deepEqual(Object.keys(state).sort(), ["agent", "kind"]);
});

test("without a folder picker the card steps aside instead of dead-ending", () => {
  // Web and mobile have no picker, and this card replaces the timeline.
  assert.deepEqual(spaceFirstTaskState(input({ folderPickerAvailable: false })), {
    kind: "hidden",
  });
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
  assert.deepEqual(state, { kind: "needs-workspace", agent: agent({ id: "agent-3", name: "claude macbook" }) });
});

test("no Space selected means nothing to guide", () => {
  assert.deepEqual(spaceFirstTaskState(input({ spaceId: null })), { kind: "hidden" });
});

test("the suggested folder name follows the Space, with a fallback", () => {
  assert.equal(suggestedSpaceFolderName("yibo-test"), "yibo-test");
  assert.equal(suggestedSpaceFolderName("  "), "xmatrix");
  assert.equal(suggestedSpaceFolderName(undefined), "xmatrix");
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

test("the Auto address itself is a valid first message", () => {
  assert.deepEqual(
    composeFirstTaskMessage({
      workspacePath: "/Users/dev/demo",
      message: "   ",
    }),
    { ok: true, body: "@auto pwd:/Users/dev/demo" }
  );
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

test("no folder chosen yet is refused before send", () => {
  assert.deepEqual(
    composeFirstTaskMessage({
      workspacePath: "",
      message: "Write notes.md",
    }),
    { ok: false, reason: "Choose a folder for this space" }
  );
});

test("xMatrix's own directory is refused even if it reaches composition", () => {
  const composed = composeFirstTaskMessage({
    workspacePath: "/Users/dev/.xmatrix/worktrees/abc123",
    message: "Write notes.md",
  });
  assert.equal(composed.ok, false);
  assert.match(composed.reason, /xMatrix itself/u);
});
