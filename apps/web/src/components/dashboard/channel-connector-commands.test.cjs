const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const {
  githubFeatureCommand,
  githubSubscribeCommand,
  githubSubscriptionFeatures,
  githubSubscriptionRepository,
  githubToggledFeatures,
  githubUnsubscribeCommand,
  isGitHubRepositoryName,
} = require("./channel-connector-commands.ts");

test("a subscription source round-trips to the repository the command names", () => {
  assert.equal(githubSubscriptionRepository("github:repo:lambdalabshq/xmatrix"), "lambdalabshq/xmatrix");
  assert.equal(githubSubscriptionRepository("github:repo:Owner/Repo"), "Owner/Repo");
  // Not a repository source: leave unrecognised values alone rather than guess.
  assert.equal(githubSubscriptionRepository("github:issue:owner/repo#42"), "github:issue:owner/repo#42");
});

test("stored features are presented in manifest order and unknown names dropped", () => {
  assert.deepEqual(
    githubSubscriptionFeatures(["releases", "issues", "not-a-feature", "pulls"]),
    ["issues", "pulls", "releases"],
  );
  assert.deepEqual(githubSubscriptionFeatures([]), []);
});

test("toggling adds in manifest order and removes without reordering", () => {
  assert.deepEqual(githubToggledFeatures(["issues"], "commits"), ["issues", "commits"]);
  assert.deepEqual(githubToggledFeatures(["releases"], "issues"), ["issues", "releases"]);
  assert.deepEqual(githubToggledFeatures(["issues", "commits"], "issues"), ["commits"]);
});

test("a feature edit becomes one connector command in the direction it moved", () => {
  assert.deepEqual(
    githubFeatureCommand("LambdaLabsHQ/xmatrix", ["issues"], ["issues", "commits"]),
    { source: "github:repo:lambdalabshq/xmatrix", body: "@github:subscribe:LambdaLabsHQ/xmatrix commits" },
  );
  // unsubscribe subtracts features, so removing one is not a teardown.
  assert.deepEqual(
    githubFeatureCommand("LambdaLabsHQ/xmatrix", ["issues", "commits"], ["commits"]),
    { source: "github:repo:lambdalabshq/xmatrix", body: "@github:unsubscribe:LambdaLabsHQ/xmatrix issues" },
  );
  assert.equal(githubFeatureCommand("LambdaLabsHQ/xmatrix", ["issues"], ["issues"]), undefined);
});

test("an edit that both adds and drops events is one message of two statements", () => {
  // The human made one decision. Two channel messages would read as two.
  assert.deepEqual(
    githubFeatureCommand("LambdaLabsHQ/xmatrix", ["issues", "commits"], ["commits", "checks"]),
    {
      source: "github:repo:lambdalabshq/xmatrix",
      body: "@github:subscribe:LambdaLabsHQ/xmatrix checks\n"
        + "@github:unsubscribe:LambdaLabsHQ/xmatrix issues",
    },
  );
  // Untouched features are never restated: the command says what changed.
  assert.deepEqual(
    githubFeatureCommand("LambdaLabsHQ/xmatrix", ["issues", "commits"], []),
    {
      source: "github:repo:lambdalabshq/xmatrix",
      body: "@github:unsubscribe:LambdaLabsHQ/xmatrix issues commits",
    },
  );
});

test("subscribing sends the whole chosen set and refuses an incomplete repository", () => {
  assert.deepEqual(
    githubSubscribeCommand("owner/repo", ["issues", "comments"]),
    { source: "github:repo:owner/repo", body: "@github:subscribe:owner/repo issues comments" },
  );
  assert.equal(githubSubscribeCommand("owner/repo", []), undefined);
  for (const incomplete of ["", "owner", "owner/", "/repo", "owner/repo/extra", "owner repo"]) {
    assert.equal(githubSubscribeCommand(incomplete, ["issues"]), undefined, incomplete);
    assert.equal(isGitHubRepositoryName(incomplete), false, incomplete);
  }
});

test("unsubscribe drops every feature so the relation is removed", () => {
  assert.deepEqual(
    githubUnsubscribeCommand(" owner/repo "),
    { source: "github:repo:owner/repo", body: "@github:unsubscribe:owner/repo all" },
  );
  assert.equal(githubUnsubscribeCommand("owner"), undefined);
});
