import assert from "node:assert/strict";

import { test } from "node:test";

import {
  githubRepositoryFeaturesFromCommand,
  githubFeatureForWebhookEvent,
  githubWebhookMessageBody,
  githubWebhookRepositoryIdentity,
  nextGitHubRepositoryFeatures,
} from "../src/github-subscription-domain.ts";

test("repository subscription commands preserve explicit and all feature selections", () => {
  assert.deepEqual(
    githubRepositoryFeaturesFromCommand("@\u200Bgithub:subscribe:LambdaLabsHQ/xmatrix all"),
    ["issues", "pulls", "comments", "reviews", "commits", "checks", "status", "releases"],
  );
  assert.deepEqual(
    githubRepositoryFeaturesFromCommand("@github:subscribe:LambdaLabsHQ/xmatrix commits,checks"),
    ["commits", "checks"],
  );
  assert.deepEqual(
    githubRepositoryFeaturesFromCommand("@github:subscribe:LambdaLabsHQ/xmatrix"),
    ["issues", "comments"],
  );
});

test("webhook repository identity is normalized for route lookup", () => {
  assert.deepEqual(githubWebhookRepositoryIdentity({
    repository: {
      name: "xMatrix",
      owner: { login: "LambdaLabsHQ" },
      html_url: "https://github.com/LambdaLabsHQ/xmatrix",
    },
  }), {
    owner: "LambdaLabsHQ",
    repo: "xMatrix",
    sourceRef: "github:repo:lambdalabshq/xmatrix",
    url: "https://github.com/LambdaLabsHQ/xmatrix",
  });
});

test("repository feature updates merge subscriptions and remove only requested features", () => {
  assert.deepEqual(
    nextGitHubRepositoryFeatures(["issues", "comments"], ["commits"], "subscribe"),
    ["issues", "comments", "commits"],
  );
  assert.deepEqual(
    nextGitHubRepositoryFeatures(["issues", "comments", "reviews"], ["comments"], "unsubscribe"),
    ["issues", "reviews"],
  );
  assert.deepEqual(
    nextGitHubRepositoryFeatures(["issues", "comments"], ["issues", "comments"], "unsubscribe"),
    [],
  );
});

test("GitHub webhook event classes map to repository subscription features", () => {
  assert.equal(githubFeatureForWebhookEvent("push", {}), "commits");
  assert.equal(githubFeatureForWebhookEvent("issues", {}), "issues");
  assert.equal(githubFeatureForWebhookEvent("pull_request", {}), "pulls");
  assert.equal(githubFeatureForWebhookEvent("issue_comment", {}), "comments");
  assert.equal(githubFeatureForWebhookEvent("pull_request_review", {}), "reviews");
  assert.equal(githubFeatureForWebhookEvent("check_run", {}), "checks");
  assert.equal(githubFeatureForWebhookEvent("workflow_run", {}), "status");
  assert.equal(githubFeatureForWebhookEvent("release", {}), "releases");
  assert.equal(githubFeatureForWebhookEvent("installation", {}), undefined);
});

test("push webhook messages are bounded summaries with repository context", () => {
  const body = githubWebhookMessageBody("push", {
    ref: "refs/heads/main",
    distinct_size: 10,
    compare: "https://github.com/LambdaLabsHQ/xmatrix/compare/a...b",
    pusher: { name: "octocat" },
    commits: Array.from({ length: 12 }, (_, index) => ({
      id: `${index}`.padEnd(40, "a"),
      message: `commit ${index}`,
      url: `https://github.com/LambdaLabsHQ/xmatrix/commit/${index}`,
    })),
  }, {
    owner: "LambdaLabsHQ",
    repo: "xmatrix",
    url: "https://github.com/LambdaLabsHQ/xmatrix",
  });
  assert.match(body, /octocat pushed 10 commits/u);
  assert.match(body, /main/u);
  assert.match(body, /2 more commits omitted/u);
  assert.equal(body.split("\n").length, 10);
});
