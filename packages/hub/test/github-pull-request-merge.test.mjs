import assert from "node:assert/strict";

import { test } from "node:test";

import {
  executeAppConnectorProviderAction,
} from "../src/app-connectors.ts";
import { isGitHubConnectorCommand } from "../src/connectors/github-command.ts";
import { githubProviderManifest, stubGitHubInstallation, githubActionContext, githubAppEnv, jsonResponse } from "./support/github-app.mjs";

const GITHUB_APP_ENV = await githubAppEnv();

function stubGitHub(permissions) {
  return stubGitHubInstallation(permissions, (call) => {
    const { url } = call;
    if (url.endsWith("/issues/42")) {
      return jsonResponse({
        number: 42,
        title: "Connector merge",
        state: "open",
        html_url: "https://github.com/LambdaLabsHQ/xmatrix/pull/42",
        pull_request: { url: "https://api.github.com/repos/LambdaLabsHQ/xmatrix/pulls/42" },
      });
    }
    if (url.includes("/issues/42/comments")) return jsonResponse([]);
    if (url.includes("/pulls/42/files")) return jsonResponse([]);
    if (url.endsWith("/pulls/42") && call.method === "GET") {
      return jsonResponse({
        html_url: "https://github.com/LambdaLabsHQ/xmatrix/pull/42",
        state: "open",
        merged: false,
        mergeable: true,
        base: { ref: "main", sha: "base" },
        head: { ref: "fix/example", sha: "head" },
      });
    }
    if (url.endsWith("/pulls/42/merge") && call.method === "PUT") {
      return jsonResponse({ merged: true, sha: "merge-sha", message: "Pull Request successfully merged" });
    }
    return jsonResponse({});
  });
}

function mergeContext(body) {
  return githubActionContext(GITHUB_APP_ENV, { actionId: "merge", actionLabel: "Merge pull request", body });
}

test("GitHub merge is a default connector action without a per-channel write setting", async () => {
  const github = githubProviderManifest();
  assert.ok(github.actions.some((action) => action.id === "merge"));
  assert.ok(!github.connectionMetadata.some((field) => field.id === "mergeWriteChannelId"));

  const merge = github.actions.find((action) => action.id === "merge");
  assert.equal(merge.effect, "write");
  assert.ok(isGitHubConnectorCommand("@github:merge:LambdaLabsHQ/xmatrix:#42"));
});

test("GitHub merge uses the repository-scoped App token and requested merge method", async () => {
  const github = stubGitHub({ metadata: "read", issues: "read", pull_requests: "write" });
  try {
    const result = await executeAppConnectorProviderAction(
      mergeContext("@github:merge:LambdaLabsHQ/xmatrix:#42 squash"),
    );
    assert.equal(result.type, "github_pull_request_merged");
    assert.equal(result.merge.merged, true);
    assert.equal(result.merge.method, "squash");
    assert.equal(result.merge.sha, "merge-sha");

    const merge = github.calls.find((call) => call.url.endsWith("/pulls/42/merge"));
    assert.ok(merge);
    assert.equal(merge.method, "PUT");
    assert.deepEqual(merge.body, { merge_method: "squash" });
    const mints = github.calls.filter((call) => call.url.includes("/access_tokens"));
    assert.ok(mints.length >= 1);
    assert.ok(mints.every((call) => JSON.stringify(call.body) === JSON.stringify({ repositories: ["xmatrix"] })));
  } finally {
    github.restore();
  }
});

test("GitHub merge fails closed when the installation lacks pull request write", async () => {
  const github = stubGitHub({ metadata: "read", issues: "read", pull_requests: "read" });
  try {
    const result = await executeAppConnectorProviderAction(
      mergeContext("@github:merge:LambdaLabsHQ/xmatrix:#42"),
    );
    assert.deepEqual(result, {
      type: "terminal",
      status: "blocked",
      reason: "missing_capabilities:github.pull_requests.write",
    });
    assert.ok(!github.calls.some((call) => call.url.endsWith("/pulls/42/merge")));
  } finally {
    github.restore();
  }
});
