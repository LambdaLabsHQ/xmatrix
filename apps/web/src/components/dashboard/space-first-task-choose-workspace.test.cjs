const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { isRootOrHomeDirectory, reviewChosenWorkspace } = require("./space-first-task-choose-workspace.ts");

function candidate(overrides = {}) {
  return {
    path: "/Users/dev/Projects/demo",
    canonicalCwd: "/Users/dev/Projects/demo",
    displayName: "demo",
    hostId: "macbook",
    hostName: "macbook",
    ...overrides,
  };
}

test("a chosen project folder is accepted and keeps its machine identity", () => {
  const outcome = reviewChosenWorkspace(candidate());
  assert.equal(outcome.kind, "chosen");
  assert.equal(outcome.workspace.canonicalCwd, "/Users/dev/Projects/demo");
  assert.equal(outcome.workspace.displayName, "demo");
  // registerWorkspace needs these, so the reduced copy must not drop them.
  assert.equal(outcome.workspace.hostId, "macbook");
  assert.equal(outcome.workspace.hostName, "macbook");
});

test("closing the picker is not an error", () => {
  assert.deepEqual(reviewChosenWorkspace(null), { kind: "cancelled" });
  assert.deepEqual(reviewChosenWorkspace(undefined), { kind: "cancelled" });
  assert.deepEqual(reviewChosenWorkspace(candidate({ canonicalCwd: "   " })), {
    kind: "cancelled",
  });
});

test("a folder belonging to xMatrix itself is refused", () => {
  const outcome = reviewChosenWorkspace(
    candidate({ canonicalCwd: "/Users/dev/.xmatrix/worktrees/abc123" })
  );
  assert.equal(outcome.kind, "rejected");
  assert.match(outcome.reason, /xMatrix itself/u);
});

test("the home folder and the disk root are refused", () => {
  // Granting either hands the agent everything the human owns.
  for (const canonicalCwd of ["/Users/dev", "/home/dev", "/", "C:\\Users\\dev", "C:\\"]) {
    const outcome = reviewChosenWorkspace(candidate({ canonicalCwd }));
    assert.equal(outcome.kind, "rejected", canonicalCwd);
    assert.match(outcome.reason, /project folder/u);
  }
});

test("a folder inside the home folder is still fine", () => {
  assert.equal(isRootOrHomeDirectory("/Users/dev/Projects"), false);
  assert.equal(isRootOrHomeDirectory("C:\\Users\\dev\\Projects"), false);
  assert.equal(reviewChosenWorkspace(candidate({ canonicalCwd: "/Users/dev/Projects" })).kind, "chosen");
});

test("a trailing separator does not turn a project folder into the root", () => {
  assert.equal(isRootOrHomeDirectory("/Users/dev/Projects/"), false);
  assert.equal(isRootOrHomeDirectory("/Users/dev/"), true);
});

test("a display name is derived when the picker did not supply one", () => {
  const outcome = reviewChosenWorkspace(candidate({ displayName: "  " }));
  assert.equal(outcome.kind, "chosen");
  assert.equal(outcome.workspace.displayName, "demo");
});
