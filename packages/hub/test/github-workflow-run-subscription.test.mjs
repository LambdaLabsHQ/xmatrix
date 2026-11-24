import assert from "node:assert/strict";
import { test } from "node:test";

import {
  githubWorkflowRunSourceRef,
  parseGitHubWorkflowRunUrl,
  subscribeRunToWorkflowRun,
  WorkflowRunUrlInvalid,
} from "../src/github-workflow-run-subscription.ts";
import { dispatchProductGitHubWebhook } from "../src/product-github-webhook-authority-adapter.ts";

/**
 * A conversation follows one workflow run instead of an Agent polling GitHub:
 * the run's verdict arrives once, when it completes, and ends the relation.
 */

const base = { installation: { id: 42 }, repository: { name: "app", owner: { login: "acme" }, private: true } };
const runRoute = { relationId: "run-relation", installationId: "42", sourceRef: "github:run:acme/app#901",
  sourceKind: "workflow_run", createdAt: "2026-11-24T21:00:00.000Z", spaceId: "space-1", channelId: "channel-1",
  connectionId: "connection-1", authorityRootUserId: "user-1", features: ["status"] };

function harness(routes) {
  const appended = [];
  const woken = [];
  const commands = [];
  return {
    appended, woken, commands,
    dependencies: {
      delegated: async () => true,
      exposure: { channel: async () => ({ id: "channel-1", spaceId: "space-1", mode: "closed" }),
        openParticipation: async () => false },
      resolveRoutes: async (_env, installationId, sourceRefs, feature) => routes.filter((route) =>
        installationId === "42" && sourceRefs.includes(route.sourceRef) && route.features.includes(feature)),
      append: async (_env, channelId, input) => { appended.push({ channelId, ...input }); return { ok: true }; },
      checkVerdict: async () => assert.fail("a workflow run reads no check verdict"),
      wake: async (_env, input) => { woken.push(input); },
      command: async (_env, kind, input) => { commands.push({ kind, input }); },
    },
  };
}

function runEvent(action, run = {}) {
  return { env: {}, event: "workflow_run", delivery: `d-${action}`, payload: { ...base, action,
    workflow_run: { id: 901, name: "Production Release", display_title: "Release cli", run_number: 88,
      status: action === "completed" ? "completed" : "in_progress", conclusion: action === "completed" ? "failure" : null,
      html_url: "https://github.com/acme/app/actions/runs/901", ...run } } };
}

test("a workflow run is named by its URL", () => {
  assert.deepEqual(parseGitHubWorkflowRunUrl("https://github.com/Acme/app/actions/runs/901"),
    { owner: "Acme", repo: "app", runId: 901 });
  assert.deepEqual(parseGitHubWorkflowRunUrl(" https://github.com/acme/app/actions/runs/901/job/7 "),
    { owner: "acme", repo: "app", runId: 901 });
  for (const url of ["https://github.com/acme/app/pull/7", "https://example.com/acme/app/actions/runs/1",
    "https://github.com/acme/app/actions/runs/0", 7]) {
    assert.throws(() => parseGitHubWorkflowRunUrl(url), WorkflowRunUrlInvalid, String(url));
  }
  assert.equal(githubWorkflowRunSourceRef("Acme/App", 901), "github:run:acme/app#901");
});

test("a followed run says nothing until it completes, then its verdict once, and stops following", async () => {
  const h = harness([runRoute]);
  assert.equal((await dispatchProductGitHubWebhook(runEvent("in_progress"), h.dependencies)).delivered, 0);
  assert.equal(h.commands.length, 0, "a run still going keeps its relation");
  assert.equal((await dispatchProductGitHubWebhook(runEvent("completed"), h.dependencies)).delivered, 1);
  assert.equal(h.appended[0].body,
    "Workflow run [Release cli #88](https://github.com/acme/app/actions/runs/901) in acme/app failed.");
  assert.equal(h.appended[0].appAuthorId, "github");
  assert.equal(h.woken[0].sourceMessageId, h.appended[0].messageId, "the verdict wakes the waiting Agent");
  assert.deepEqual(h.commands.map(({ kind, input }) => [kind, input.relationId, input.principal.id]),
    [["remove-relation", "run-relation", "user-1"]]);
  await dispatchProductGitHubWebhook({ ...runEvent("completed"), delivery: "d-again" }, h.dependencies);
  assert.equal(h.appended[1].messageId, h.appended[0].messageId, "a redelivered verdict is the same message");
});

test("another run of the repository reaches no run subscription", async () => {
  const h = harness([runRoute]);
  const other = runEvent("completed", { id: 902 });
  assert.equal((await dispatchProductGitHubWebhook(other, h.dependencies)).delivered, 0);
  assert.equal(h.appended.length + h.commands.length, 0);
});

test("subscribing tells the Agent whether to wait", async () => {
  const commands = [];
  const connection = { id: "connection-1", status: "configured" };
  const subscriber = { spaceId: "space-1", channelId: "channel-1", ownerUserId: "user-1", commandId: "c-1",
    url: "https://github.com/acme/app/actions/runs/901" };
  const dependencies = (run, reach = true) => ({
    findConnection: async () => connection,
    installationFor: async () => { if (!reach) throw new Error("github_installation_missing"); },
    readRun: async () => run,
    command: async (_env, kind, input) => { commands.push({ kind, input }); },
  });
  const running = { status: "in_progress", conclusion: "", name: "Release cli", runNumber: 88,
    url: "https://github.com/acme/app/actions/runs/901" };
  assert.deepEqual(await subscribeRunToWorkflowRun({}, subscriber, dependencies(running)), {
    repository: "acme/app", runId: 901, subscription: "subscribed", name: "Release cli",
    url: "https://github.com/acme/app/actions/runs/901" });
  assert.deepEqual(commands.map(({ kind, input }) => [kind, input.sourceKind, input.sourceRef, input.features]),
    [["put-relation", "workflow_run", "github:run:acme/app#901", ["status"]]]);
  const done = await subscribeRunToWorkflowRun({}, subscriber,
    dependencies({ ...running, status: "completed", conclusion: "success" }));
  assert.equal(done.subscription, "completed");
  assert.equal(done.conclusion, "success");
  assert.equal((await subscribeRunToWorkflowRun({}, subscriber, dependencies(running, false))).subscription,
    "unreachable");
  assert.equal(commands.length, 1, "a finished or unreachable run is not followed");
});
