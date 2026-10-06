import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executeAppConnectorProviderAction,
} from "../src/app-connectors.ts";
import { isGitHubConnectorCommand } from "../src/connectors/github-command.ts";
import {
  githubProviderManifest, stubGitHubInstallation, githubActionContext, githubAppEnv, githubConnection, jsonResponse,
} from "./support/github-app.mjs";

const GITHUB_APP_ENV = await githubAppEnv();

function connection(overrides = {}) {
  return githubConnection({
    scopes: ["actions:write"],
    capabilities: ["github.actions.write"],
    metadata: {
      installationIds: ["777"],
      actionsWriteChannelId: "channel-1",
      actionsWorkflowIds: ["production-release-request.yml"],
    },
    ...overrides,
  });
}

function actionContext(actionId, body, connectionOverride) {
  return githubActionContext(GITHUB_APP_ENV, { actionId, body, connection: connectionOverride || connection() });
}

function stubGitHub(permissions) {
  return stubGitHubInstallation(permissions, (call) => {
    if (call.method === "POST") return jsonResponse(undefined, 204);
    return jsonResponse({ id: 1, full_name: "LambdaLabsHQ/xmatrix" });
  });
}

async function withDispatchedWorkflow(body, verify) {
  const github = stubGitHub({ metadata: "read", actions: "write" });
  try {
    const result = await executeAppConnectorProviderAction(actionContext("dispatch_workflow", body));
    await verify(result, github);
  } finally { github.restore(); }
}

test("GitHub Actions writes are typed, capability-gated, and Channel-gated", async () => {
  const github = githubProviderManifest();
  assert.ok(github.auth.scopes.includes("actions:write"));
  assert.ok(github.auth.capabilities.some((capability) => capability.id === "github.actions.write"));
  assert.ok(github.connectionMetadata.some((field) => field.id === "actionsWriteChannelId"));
  assert.ok(github.connectionMetadata.some((field) => field.id === "actionsWorkflowIds"));
  assert.ok(github.actions.some((action) => action.id === "rerun_failed_jobs"));
  assert.ok(github.actions.some((action) => action.id === "dispatch_workflow"));

  assert.ok(isGitHubConnectorCommand("@github:rerun_failed_jobs:LambdaLabsHQ/xmatrix:1"));
  assert.ok(isGitHubConnectorCommand("@github:dispatch_workflow:LambdaLabsHQ/xmatrix:main release.yml"));
});

test("rerun_failed_jobs uses a repository-scoped token and the failed-jobs endpoint", async () => {
  const github = stubGitHub({ metadata: "read", actions: "write" });
  try {
    const result = await executeAppConnectorProviderAction(actionContext(
      "rerun_failed_jobs",
      "@github:rerun_failed_jobs:LambdaLabsHQ/xmatrix:33849821375",
    ));
    assert.equal(result.type, "github_actions_failed_jobs_rerun");
    assert.equal(result.runId, 33849821375);

    const rerun = github.calls.find((call) => call.url.endsWith("/actions/runs/33849821375/rerun-failed-jobs"));
    assert.equal(rerun?.method, "POST");
    const mint = github.calls.find((call) => call.url.includes("/access_tokens"));
    assert.deepEqual(mint?.body, { repositories: ["xmatrix"] });
  } finally {
    github.restore();
  }
});

test("Actions writes are off by default per Channel and fail closed on a missing live installation permission", async () => {
  const github = githubProviderManifest();
  for (const id of ["rerun_failed_jobs", "dispatch_workflow", "comment", "create_issue", "close_issue", "reopen_issue", "review"]) {
    const action = github.actions.find((candidate) => candidate.id === id);
    assert.equal(action.effect, "write", id);
    assert.equal(action.defaultPolicy, "deny", `${id} runs only where a Channel allows it`);
  }
  const { actionRefusal } = await import("../src/connectors/connector-commands.ts");
  const gate = { providerId: "github", actionId: "rerun_failed_jobs", effect: "write", defaultPolicy: "deny" };
  assert.match(actionRefusal({ ...gate, mode: null, senderKind: "user" }), /@github:policy:rerun_failed_jobs allow/u);
  assert.equal(actionRefusal({ ...gate, mode: "allow", senderKind: "user" }), undefined);

  const stub = stubGitHub({ metadata: "read", actions: "read" });
  try {
    const missingPermission = await executeAppConnectorProviderAction(actionContext(
      "rerun_failed_jobs",
      "@github:rerun_failed_jobs:LambdaLabsHQ/xmatrix:33849821375",
    ));
    assert.deepEqual(missingPermission, {
      type: "terminal",
      status: "blocked",
      reason: "missing_capabilities:github.actions.write",
    });
    assert.ok(!stub.calls.some((call) => call.url.includes("/rerun-failed-jobs")));
  } finally {
    stub.restore();
  }
});

test("dispatch_workflow sends an explicit ref and bounded scalar JSON inputs", async () => {
  await withDispatchedWorkflow(
      '@github:dispatch_workflow:LambdaLabsHQ/xmatrix:production-release-request.yml:main {"version_tag":"xmatrix-v0.16.163","dry_run":false}',
    async (result, github) => {
    assert.equal(result.type, "github_workflow_dispatched");
    assert.equal(result.workflowId, "production-release-request.yml");
    assert.equal(result.ref, "main");
    const dispatch = github.calls.find((call) => call.url.endsWith("/actions/workflows/production-release-request.yml/dispatches"));
    assert.equal(dispatch?.method, "POST");
    assert.deepEqual(dispatch?.body, {
      ref: "main",
      inputs: { version_tag: "xmatrix-v0.16.163", dry_run: false },
    });
  });
});

test("dispatch_workflow rejects untyped or oversized input shapes before GitHub", async () => {
  await withDispatchedWorkflow(
      '@github:dispatch_workflow:LambdaLabsHQ/xmatrix:production-release-request.yml:main {"nested":{"unsafe":true}}',
    async (result, github) => {
    assert.deepEqual(result, {
      type: "terminal",
      status: "failed",
      reason: "invalid_github_workflow_inputs",
    });
    assert.equal(github.calls.length, 0);
  });
});

test("dispatch_workflow rejects a workflow outside the connection allowlist before GitHub", async () => {
  await withDispatchedWorkflow(
      "@github:dispatch_workflow:LambdaLabsHQ/xmatrix:production-release.yml:xmatrix-v0.16.163",
    async (result, github) => {
    assert.deepEqual(result, {
      type: "terminal",
      status: "blocked",
      reason: "github_workflow_not_allowed",
    });
    assert.equal(github.calls.length, 0);
  });
});
