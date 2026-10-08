import assert from "node:assert/strict";
import { test } from "node:test";

import {
  githubIssueSourceRef,
  githubPullRequestEventMessage,
  githubWebhookIssueNumbers,
  subscribeConversationToPullRequest,
} from "../src/github-pull-request-subscription.ts";
import { dispatchProductGitHubWebhook } from "../src/product-github-webhook-authority-adapter.ts";

/**
 * A pull request a Run opens is subscribed to its conversation
 * (docs/design/conversation-activity.md §3.6): what its opener needs to hear
 * comes back there, and the subscription ends when the pull request closes.
 */

const repository = { owner: "acme", repo: "app", url: "https://github.com/acme/app" };
const pull = { number: 7, title: "Fix it", html_url: "https://github.com/acme/app/pull/7",
  user: { login: "Opener" } };

function message(event, payload, verdict) {
  return githubPullRequestEventMessage({ event, payload, repository, number: 7, ...(verdict ? { verdict } : {}) });
}

test("an event names the pull requests it is about", () => {
  assert.deepEqual(githubWebhookIssueNumbers("pull_request", { pull_request: pull }), [7]);
  assert.deepEqual(githubWebhookIssueNumbers("pull_request_review", { pull_request: pull }), [7]);
  assert.deepEqual(githubWebhookIssueNumbers("issue_comment", { issue: { number: 9 } }), [9]);
  assert.deepEqual(githubWebhookIssueNumbers("check_suite", { check_suite: {
    pull_requests: [{ number: 7 }, { number: 8 }, { number: 7 }, { number: "x" }] } }), [7, 8]);
  assert.deepEqual(githubWebhookIssueNumbers("check_suite", { check_suite: {} }), []);
  assert.equal(githubIssueSourceRef("Acme/App", 7), "github:issue:acme/app#7");
});

test("the opener hears others' merge, reviews and comments, never its own", () => {
  assert.equal(message("pull_request", { action: "closed", pull_request: { ...pull, merged: true },
    sender: { login: "yiming" } }), "yiming merged pull request [acme/app#7](https://github.com/acme/app/pull/7): Fix it");
  assert.match(message("pull_request", { action: "closed", pull_request: pull, sender: { login: "yiming" } }),
    /^yiming closed pull request/u);
  assert.equal(message("pull_request", { action: "closed", pull_request: { ...pull, merged: true },
    sender: { login: "opener" } }), undefined, "its own merge");
  assert.equal(message("pull_request", { action: "synchronize", pull_request: pull, sender: { login: "x" } }),
    undefined);
  assert.equal(message("pull_request_review", { action: "submitted", pull_request: pull, sender: { login: "codex" },
    review: { state: "CHANGES_REQUESTED", body: "Handle the empty case.", user: { login: "codex" } } }),
  "codex changes requested [acme/app#7](https://github.com/acme/app/pull/7)\n\nHandle the empty case.");
  assert.equal(message("pull_request_review", { action: "submitted", pull_request: pull, sender: { login: "Opener" },
    review: { state: "COMMENTED", user: { login: "Opener" } } }), undefined);
  assert.match(message("issue_comment", { action: "created", issue: pull, sender: { login: "yiming" },
    comment: { body: "Why?", user: { login: "yiming" }, html_url: "https://github.com/acme/app/pull/7#c1" } }),
  /^yiming commented on \[acme\/app#7\].*\(\[comment\]\(https:\/\/github\.com\/acme\/app\/pull\/7#c1\)\)\n\nWhy\?$/u);
  assert.equal(message("issue_comment", { action: "created", issue: pull, comment: { body: "done",
    user: { login: "opener" } } }), undefined, "its own comment");
  assert.equal(message("issue_comment", { action: "edited", issue: pull, comment: { body: "x",
    user: { login: "yiming" } } }), undefined);
});

test("CI speaks once, when every check has settled", () => {
  const payload = { action: "completed", check_suite: { head_sha: "abcdef1234567", pull_requests: [{ number: 7 }] } };
  assert.equal(message("check_suite", payload), undefined);
  assert.equal(message("check_suite", payload, { state: "pending" }), undefined);
  assert.equal(message("check_suite", payload, { state: "passed", failed: [], settledAt: "t" }),
    "CI passed on [acme/app#7](https://github.com/acme/app/pull/7) at abcdef1.");
  assert.equal(message("check_suite", payload, { state: "failed", settledAt: "t",
    failed: [{ name: "hub", url: "https://github.com/acme/app/runs/1" }, { name: "web" }] }),
  "CI failed on [acme/app#7](https://github.com/acme/app/pull/7) at abcdef1: [hub](https://github.com/acme/app/runs/1), web.");
  assert.equal(message("check_run", { action: "completed" }, { state: "passed", failed: [], settledAt: "t" }),
    undefined, "single checks are not news");
});

function harness({ routes, verdict = { state: "passed", failed: [], settledAt: "2026-10-08T22:00:00Z" },
  features = ["pulls", "comments", "reviews", "checks"], repositoryFeatures = ["commits"] } = {}) {
  const appended = [];
  const woken = [];
  const commands = [];
  const verdicts = [];
  return {
    appended, woken, commands, verdicts,
    dependencies: {
      exposure: { channel: async () => ({ id: "channel-1", spaceId: "space-1", mode: "closed" }),
        openParticipation: async () => false },
      resolveRoutes: async (_env, installationId, sourceRefs) => routes.filter((route) =>
        installationId === "42" && sourceRefs.includes(route.sourceRef)),
      listConnections: async (_env, { channelId }) => [{ id: "connection-1", providerId: "github",
        status: "configured", channelState: { channelId, bound: true, subscriptions: routes
          .filter((route) => route.channelId === channelId)
          .map((route) => ({ kind: route.sourceKind, source: route.sourceRef,
            features: route.sourceKind === "issue" ? features : repositoryFeatures })) } }],
      append: async (_env, channelId, input) => {
        appended.push({ channelId, ...input });
        return { ok: true };
      },
      checkVerdict: async (...args) => {
        verdicts.push(args.slice(1));
        return verdict;
      },
      wake: async (_env, input) => { woken.push(input); },
      command: async (_env, kind, input) => { commands.push({ kind, input }); },
    },
  };
}

const issueRoute = { relationId: "imported-pull-request-relation", installationId: "42", sourceRef: "github:issue:acme/app#7", sourceKind: "issue",
  createdAt: "2026-10-08T22:00:00.000Z",
  spaceId: "space-1", channelId: "channel-1", connectionId: "connection-1", authorityRootUserId: "user-1" };
const base = { installation: { id: 42 }, repository: { name: "app", owner: { login: "acme" }, private: true } };

test("a settled verdict reaches the pull request's conversation once and wakes it", async () => {
  const h = harness({ routes: [issueRoute] });
  const payload = { ...base, action: "completed",
    check_suite: { head_sha: "abcdef1234567", pull_requests: [{ number: 7 }] } };
  const first = await dispatchProductGitHubWebhook({ env: {}, event: "check_suite", delivery: "d-1", payload },
    h.dependencies);
  await dispatchProductGitHubWebhook({ env: {}, event: "check_suite", delivery: "d-2", payload }, h.dependencies);
  assert.equal(first.delivered, 1);
  assert.deepEqual(h.verdicts[0], ["42", "acme", "app", "abcdef1234567"]);
  assert.equal(h.appended[0].body, "CI passed on [acme/app#7](https://github.com/acme/app/pull/7) at abcdef1.");
  assert.equal(h.appended[0].appAuthorId, "github");
  assert.equal(h.appended[0].messageId, h.appended[1].messageId,
    "two suites' deliveries of one settling are one message");
  assert.equal(h.woken[0].channelId, "channel-1");
  assert.equal(h.woken[0].sourceMessageId, h.appended[0].messageId);
  assert.equal(h.commands.length, 0);
});

test("a pending verdict and an unsubscribed pull request say nothing", async () => {
  const pending = harness({ routes: [issueRoute], verdict: { state: "pending" } });
  const payload = { ...base, action: "completed",
    check_suite: { head_sha: "abc", pull_requests: [{ number: 7 }] } };
  assert.equal((await dispatchProductGitHubWebhook({ env: {}, event: "check_suite", delivery: "d-1", payload },
    pending.dependencies)).delivered, 0);
  const other = harness({ routes: [issueRoute] });
  await dispatchProductGitHubWebhook({ env: {}, event: "check_suite", delivery: "d-1", payload: { ...payload,
    check_suite: { head_sha: "abc", pull_requests: [{ number: 8 }] } } }, other.dependencies);
  assert.equal(other.verdicts.length, 0, "no subscribed pull request, no GitHub read");
  assert.equal(other.appended.length + pending.appended.length + pending.woken.length, 0);
});

test("closing the pull request is said and ends its subscription, even its author's own merge", async () => {
  for (const [sender, said] of [["yiming", 1], ["opener", 0]]) {
    const h = harness({ routes: [issueRoute] });
    await dispatchProductGitHubWebhook({ env: {}, event: "pull_request", delivery: "d-9", payload: { ...base,
      action: "closed", pull_request: { ...pull, merged: true }, sender: { login: sender } } }, h.dependencies);
    assert.equal(h.appended.length, said, sender);
    assert.deepEqual(h.commands.map(({ kind, input }) => [kind, input.relationId, input.principal.id]),
      [["remove-relation", "imported-pull-request-relation", "user-1"]], sender);
  }
});

test("a repository subscription in the same delivery keeps posting what it always did", async () => {
  const repositoryRoute = { ...issueRoute, sourceRef: "github:repo:acme/app", sourceKind: "repository",
    channelId: "channel-2" };
  const h = harness({ routes: [issueRoute, repositoryRoute], repositoryFeatures: ["pulls"] });
  await dispatchProductGitHubWebhook({ env: {}, event: "pull_request", delivery: "d-3", payload: { ...base,
    action: "opened", pull_request: pull, sender: { login: "opener" } } }, h.dependencies);
  assert.deepEqual(h.appended.map((entry) => entry.channelId), ["channel-2"],
    "the repository's Channel hears it opened; the pull request's own conversation already knows");
  assert.match(h.appended[0].body, /opener opened pull request/u);
});

test("a subscription without the event's feature is not delivered", async () => {
  const h = harness({ routes: [issueRoute], features: ["pulls"] });
  await dispatchProductGitHubWebhook({ env: {}, event: "issue_comment", delivery: "d-4", payload: { ...base,
    action: "created", issue: pull, comment: { body: "hi", user: { login: "yiming" } },
    sender: { login: "yiming" } } }, h.dependencies);
  assert.equal(h.appended.length, 0);
});

test("a pull request is subscribed only through the Space's connection that reaches it", async () => {
  const commands = [];
  const input = { spaceId: "space-1", channelId: "channel-1", ownerUserId: "user-1",
    repository: "Acme/App", number: 7, commandId: "activity:r-1" };
  const connection = { id: "space-1:github", status: "configured" };
  const deps = (overrides) => ({ findConnection: async () => connection, installationFor: async () => "42",
    command: async (_env, kind, value) => { commands.push({ kind, value }); }, ...overrides });
  assert.equal(await subscribeConversationToPullRequest({}, input, deps()), true);
  assert.deepEqual(commands[0], { kind: "put-relation", value: {
    commandId: "product:github-pull-request:activity:r-1", connectionId: "space-1:github",
    channelId: "channel-1", sourceKind: "issue", sourceRef: "github:issue:acme/app#7",
    features: ["pulls", "comments", "reviews", "checks"], principal: { kind: "user", id: "user-1" } } });
  assert.equal(await subscribeConversationToPullRequest({}, input, deps({ findConnection: async () => null })), false);
  assert.equal(await subscribeConversationToPullRequest({}, input, deps({
    installationFor: async () => { throw new Error("github_installation_not_linked_to_space"); } })), false);
  assert.equal(commands.length, 1);
});

test("a subscription made before its issue existed named an earlier issue and hears nothing", async () => {
  const stale = { ...issueRoute, createdAt: "2026-06-19T08:36:35.989Z" };
  const h = harness({ routes: [stale] });
  const payload = { ...base, action: "created", sender: { login: "yiming" },
    issue: { ...pull, created_at: "2026-10-08T21:00:00Z" }, comment: { body: "hi", user: { login: "yiming" } } };
  await dispatchProductGitHubWebhook({ env: {}, event: "issue_comment", delivery: "d-5", payload }, h.dependencies);
  assert.equal(h.appended.length, 0);
  const current = harness({ routes: [issueRoute] });
  await dispatchProductGitHubWebhook({ env: {}, event: "issue_comment", delivery: "d-5", payload },
    current.dependencies);
  assert.equal(current.appended.length, 1);
});
