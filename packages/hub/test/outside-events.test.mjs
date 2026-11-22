import assert from "node:assert/strict";
import test from "node:test";
import * as subscriptionDomain from "../src/github-subscription-domain.ts";
import { appStream, eventsStream, githubStream } from "../src/norn-host.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const load = await compileCommonJsSourceModule(new URL("../src/outside-events.ts", import.meta.url));
const repository = { full_name: "acme/widgets", default_branch: "main" };
const installation = { id: 42 };
const failedRun = (branch) => ({ action: "completed", installation, repository,
  workflow_run: { id: 5, name: "CI", conclusion: "failure", head_branch: branch, html_url: "https://github.com/acme/widgets/actions/runs/5" } });
const stream = (name, argument, labels = {}) => ({ name, args: [{ type: "string", value: argument }],
  labels: Object.fromEntries(Object.entries(labels).map(([label, value]) => [label, { type: "string", value }])) });

/** The ingress with what it hands events to recorded; `connection` is the Space's GitHub connection, when it has one. */
function ingress({ connection = { status: "configured" }, delegated = true } = {}) {
  const heard = [], asked = [];
  const { githubOutsideEvent, githubEventArrived, connectorEventArrived } = load(name => ({
    "./app-connectors": { githubRepositoryDelegated: async (_env, _connection, installationId, owner, repo) => {
      asked.push({ installationId, owner, repo });
      return delegated;
    } },
    "./apps": { findAppConnection: async () => connection },
    "./github-subscription-domain": subscriptionDomain,
    "./norn-events": { occurNornEvent: async (_env, input) => { heard.push(input); return 1; } },
    "./norn-host": { appStream, eventsStream, githubStream },
  })[name]);
  return { heard, asked, githubOutsideEvent, githubEventArrived, connectorEventArrived };
}

test("GitHub webhooks emit structured outside events; incomplete webhooks emit none", () => {
  const { githubOutsideEvent } = ingress();
  assert.deepEqual(githubOutsideEvent("pull_request", { action: "closed", installation, repository,
    pull_request: { number: 9, merged: true, title: "Split the router", base: { ref: "main" },
      html_url: "https://github.com/acme/widgets/pull/9" } }), {
    repository: "acme/widgets", defaultBranch: "main", installationId: "42", kind: "merged", branch: "main",
    pullRequest: 9, merged: true, title: "Split the router", id: "github:acme/widgets#9:merged",
    summary: "Pull request #9 “Split the router” was merged into main",
    url: "https://github.com/acme/widgets/pull/9" });
  // Unmerged closed PR and successful workflow_run still pass through for Events libraries (not legacy ciFailed/prMerged).
  assert.equal(githubOutsideEvent("pull_request", { action: "closed", installation, repository,
    pull_request: { number: 9, merged: false, base: { ref: "main" } } })?.kind, "pull-closed");
  assert.equal(githubOutsideEvent("workflow_run", { action: "completed", installation, repository,
    workflow_run: { id: 5, name: "CI", conclusion: "success", head_branch: "main" } })?.kind, "workflow-completed");
  assert.equal(githubOutsideEvent("workflow_run", { action: "completed", installation, repository,
    workflow_run: { id: 5, run_attempt: 2, name: "CI", conclusion: "failure", head_branch: "main" } })?.id,
  "github:run:5:2");
  assert.equal(githubOutsideEvent("issues", { action: "opened", installation, repository }), undefined);
});

test("a GitHub event on the default branch reaches the programs waiting on its repository's stream, in connected Spaces", async () => {
  const f = ingress();
  await f.githubEventArrived({}, "workflow_run", failedRun("main"));
  assert.equal(f.heard.length, 1);
  const [event] = f.heard;
  assert.equal(event.spaceId, undefined);
  assert.equal(event.id, "github:run:5:1");
  assert.equal(event.what, "Workflow “CI” failed on main (https://github.com/acme/widgets/actions/runs/5)");
  assert.equal(event.matches(stream("ciFailed", "acme/widgets")), true);
  assert.equal(event.matches(stream("ciFailed", "acme/other")), false);
  assert.equal(event.matches(stream("prMerged", "acme/widgets")), false);
  // One member's connection is asked once for the event, however many of their programs wait on it.
  const program = { spaceId: "space", authorityUserId: "user" };
  assert.equal(await event.allowed(program), true);
  assert.equal(await event.allowed({ ...program }), true);
  assert.deepEqual(f.asked, [{ installationId: "42", owner: "acme", repo: "widgets" }]);

  for (const closed of [ingress({ connection: null }), ingress({ connection: { status: "disconnected" } }),
    ingress({ delegated: false })]) {
    await closed.githubEventArrived({}, "workflow_run", failedRun("main"));
    assert.equal(await closed.heard[0].allowed(program), false);
  }
});

test("non-default-branch workflows reach Events libraries but NOT legacy ciFailed; incomplete webhooks reach nothing", async () => {
  const f = ingress();
  await f.githubEventArrived({}, "workflow_run", failedRun("release"));
  await f.githubEventArrived({}, "issues", { action: "opened", installation, repository });
  assert.equal(f.heard.length, 1);
  const [releaseRun] = f.heard;
  // Legacy `ciFailed` does NOT match off-default-branch runs.
  assert.equal(releaseRun.matches(stream("ciFailed", "acme/widgets")), false);
  // Standard `Events.events(Events.kind("github", "workflow_run.completed"), ~source="acme/widgets")` DOES match so libraries filter it.
  assert.equal(releaseRun.matches({
    type: "source", kind: "stream", name: "Events.events",
    args: [{ type: "variant", name: "EventKind", args: [{ type: "string", value: "github" }, { type: "string", value: "workflow_run.completed" }] }],
    labels: { source: { type: "string", value: "acme/widgets" } },
  }), true);
  assert.deepEqual(f.asked, []);
});

test("a connector event reaches the programs of its Space waiting on the app's stream", async () => {
  const f = ingress();
  const input = { spaceId: "space", provider: "sentry", event: { eventId: "e1", sourceRef: "sentry:project",
    feature: "issue.created", summary: "A new issue", url: "https://sentry.example/1" } };
  await f.connectorEventArrived({}, input);
  const [event] = f.heard;
  assert.equal(event.spaceId, "space");
  assert.equal(event.id, JSON.stringify(["connector", "sentry", "e1"]));
  assert.equal(event.what, "A new issue (https://sentry.example/1)");
  assert.equal(event.matches(stream("appEvent", "sentry")), true);
  assert.equal(event.matches(stream("appEvent", "sentry", { feature: "issue.created" })), true);
  assert.equal(event.matches(stream("appEvent", "sentry", { feature: "issue.resolved" })), false);
  assert.equal(event.matches(stream("appEvent", "stripe")), false);
  assert.equal(await event.allowed({ spaceId: "space", authorityUserId: "anyone" }), true);
});

test("a member's own event reaches only that member's programs, and mail that names no member reaches nothing", async () => {
  const f = ingress();
  const event = { eventId: "m1", sourceRef: "gmail:inbox", feature: "message.received", summary: "New mail" };
  await f.connectorEventArrived({}, { spaceId: "space", provider: "gmail", event });
  assert.equal(f.heard.length, 0);
  await f.connectorEventArrived({}, { spaceId: "space", provider: "gmail", authorizedUserId: "owner", event });
  assert.equal(f.heard[0].what, "New mail");
  assert.equal(await f.heard[0].allowed({ spaceId: "space", authorityUserId: "owner" }), true);
  assert.equal(await f.heard[0].allowed({ spaceId: "space", authorityUserId: "other" }), false);
});
