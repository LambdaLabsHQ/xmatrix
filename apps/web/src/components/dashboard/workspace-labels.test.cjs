const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  compactWorkspacePathTail,
  repoReferenceForWorkspace,
} = require("./workspace-labels.ts");

test("workspace path tails keep the distinguishing directories", () => {
  assert.equal(compactWorkspacePathTail("/Users/eevee/code/xmatrix"), "code/xmatrix");
  assert.equal(compactWorkspacePathTail("/Users/eevee/code/xmatrix-web"), "code/xmatrix-web");
});

test("workspace path tails handle Windows paths the same way", () => {
  assert.equal(compactWorkspacePathTail("C:\\Users\\eevee\\code\\xmatrix"), "code/xmatrix");
  assert.equal(compactWorkspacePathTail("\\\\?\\C:\\Users\\eevee\\forks\\xmatrix"), "forks/xmatrix");
});

test("repo reference shortens only github.com remotes to owner/repo", () => {
  assert.equal(
    repoReferenceForWorkspace({ gitRemote: "git@github.com:LambdaLabsHQ/xmatrix.git", canonicalCwd: "/x" }),
    "LambdaLabsHQ/xmatrix"
  );
  assert.equal(
    repoReferenceForWorkspace({ gitRemote: "https://github.com/LambdaLabsHQ/xmatrix.git", canonicalCwd: "/x" }),
    "LambdaLabsHQ/xmatrix"
  );
  assert.equal(
    repoReferenceForWorkspace({ gitRemote: "ssh://git@github.com/LambdaLabsHQ/xmatrix.git", canonicalCwd: "/x" }),
    "LambdaLabsHQ/xmatrix"
  );
});

test("token-bearing remotes never leak credentials query or fragment", () => {
  assert.equal(
    repoReferenceForWorkspace({
      gitRemote: "https://user:ghp_secretToken@github.com/LambdaLabsHQ/xmatrix.git?token=abc#frag",
      canonicalCwd: "/x",
    }),
    "LambdaLabsHQ/xmatrix"
  );
  assert.equal(
    repoReferenceForWorkspace({
      gitRemote: "https://oauth2:glpat-secret@gitlab.com/team/proj.git?private_token=abc#x",
      canonicalCwd: "/x",
    }),
    "https://gitlab.com/team/proj"
  );
  for (const remote of [
    "https://user:ghp_secretToken@github.com/LambdaLabsHQ/xmatrix.git?token=abc#frag",
    "https://oauth2:glpat-secret@gitlab.com/team/proj.git?private_token=abc#x",
  ]) {
    const ref = repoReferenceForWorkspace({ gitRemote: remote, canonicalCwd: "/x" });
    assert.ok(ref);
    assert.doesNotMatch(ref, /ghp_|glpat-|secret|token=|private_token|@github|@gitlab|#|\?/i);
    assert.doesNotMatch(ref, /user:|oauth2:/);
  }
});

test("non-GitHub remotes keep a sanitized cloneable remote URL", () => {
  assert.equal(
    repoReferenceForWorkspace({ gitRemote: "https://gitlab.com/team/proj.git/", canonicalCwd: "/x" }),
    "https://gitlab.com/team/proj"
  );
  assert.equal(
    repoReferenceForWorkspace({ gitRemote: "ssh://git@bitbucket.org/team/proj.git", canonicalCwd: "/x" }),
    "ssh://git@bitbucket.org/team/proj"
  );
  assert.equal(
    repoReferenceForWorkspace({ gitRemote: "git@gitlab.com:team/proj.git", canonicalCwd: "/x" }),
    "git@gitlab.com:team/proj"
  );
});

test("local filesystem remotes do not become repo options", () => {
  assert.equal(repoReferenceForWorkspace({ gitRemote: "C:\\Users\\dev\\code\\xmatrix", canonicalCwd: "/x" }), undefined);
  assert.equal(repoReferenceForWorkspace({ gitRemote: "/srv/git/xmatrix.git", canonicalCwd: "/x" }), undefined);
  assert.equal(repoReferenceForWorkspace({ gitRemote: "./relative-repo", canonicalCwd: "/x" }), undefined);
  assert.equal(repoReferenceForWorkspace({ gitRemote: "file:///srv/git/xmatrix.git", canonicalCwd: "/x" }), undefined);
  assert.equal(repoReferenceForWorkspace({ gitRemote: "\\\\server\\share\\repo.git", canonicalCwd: "/x" }), undefined);
});

test("checkouts without a remote have no repo reference", () => {
  assert.equal(
    repoReferenceForWorkspace({ repoRoot: "/Users/dev/code/xmatrix", canonicalCwd: "/Users/dev/code/xmatrix" }),
    undefined
  );
  assert.equal(repoReferenceForWorkspace({ canonicalCwd: "/Users/dev/notes" }), undefined);
  assert.equal(repoReferenceForWorkspace({ canonicalCwd: "/x", repoRoot: "  " }), undefined);
});
