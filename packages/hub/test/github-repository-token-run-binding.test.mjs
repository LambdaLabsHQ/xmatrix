import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * A machine's repository-token request speaks for one Run. These pin that the
 * Hub mints only for the repository it admitted for that live Run, on that
 * machine, in that Channel -- not for any repository of the Space.
 */
import {
  githubRepositoryTokenRunRefusal,
  legacyUnboundRepositoryTokenEnabled,
} from "../src/github-repository-token-run-binding.ts";

const principal = { machineId: "machine-1" };

function run(overrides = {}, metadata = {}) {
  return {
    runId: "run-1",
    channelId: "channel-1",
    status: "running",
    ...overrides,
    metadata: { machineId: "machine-1", executionKey: "exec-1", remoteRepo: "LambdaLabsHQ/xmatrix", ...metadata },
  };
}

function claim(overrides = {}) {
  return {
    channelId: "channel-1",
    runId: "run-1",
    executionKey: "exec-1",
    repository: { owner: "LambdaLabsHQ", repo: "xmatrix" },
    ...overrides,
  };
}

test("the Run's own launch repository is minted, in any casing", () => {
  assert.equal(githubRepositoryTokenRunRefusal(run(), principal, claim()), undefined);
  assert.equal(githubRepositoryTokenRunRefusal(run(), principal,
    claim({ repository: { owner: "lambdalabshq", repo: "XMatrix" } })), undefined);
  assert.equal(githubRepositoryTokenRunRefusal(run({}, { remoteRepo: "https://github.com/LambdaLabsHQ/xmatrix.git" }),
    principal, claim()), undefined);
});

test("a stopping Run still pushes its handoff branch", () => {
  assert.equal(githubRepositoryTokenRunRefusal(run({ status: "stopping" }), principal, claim()), undefined);
  assert.equal(githubRepositoryTokenRunRefusal(run({ status: "starting" }), principal, claim()), undefined);
});

test("another repository of the same Space is refused", () => {
  assert.equal(
    githubRepositoryTokenRunRefusal(run(), principal, claim({ repository: { owner: "LambdaLabsHQ", repo: "secrets" } })),
    "github_repository_not_authorized_for_run",
  );
  assert.equal(
    githubRepositoryTokenRunRefusal(run({}, { remoteRepo: undefined }), principal, claim()),
    "github_repository_not_authorized_for_run",
    "a Run launched into a machine directory has no repository to mint for",
  );
});

test("a Run of another machine, Channel or execution cannot be named", () => {
  assert.equal(githubRepositoryTokenRunRefusal(run(), { machineId: "machine-2" }, claim()),
    "github_repository_token_run_machine_mismatch");
  assert.equal(githubRepositoryTokenRunRefusal(run(), principal, claim({ channelId: "channel-2" })),
    "github_repository_token_run_channel_mismatch");
  assert.equal(githubRepositoryTokenRunRefusal(run(), principal, claim({ executionKey: "exec-2" })),
    "github_repository_token_run_execution_mismatch");
  assert.equal(githubRepositoryTokenRunRefusal(run({}, { machineId: undefined }), principal, claim()),
    "github_repository_token_run_machine_mismatch");
});

test("an ended Run mints nothing", () => {
  for (const status of ["stopped", "failed", "exited", "completed", undefined]) {
    assert.equal(githubRepositoryTokenRunRefusal(run({ status }), principal, claim()),
      "github_repository_token_run_not_live");
  }
});

test("daemons that name no Run are admitted only while the compatibility flag is on", () => {
  assert.equal(legacyUnboundRepositoryTokenEnabled({ GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED: "true" }), true);
  for (const value of [undefined, "", "false", "1", "TRUE"]) {
    assert.equal(legacyUnboundRepositoryTokenEnabled({ GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED: value }), false);
  }
});
