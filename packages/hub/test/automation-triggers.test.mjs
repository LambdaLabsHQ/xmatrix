import assert from "node:assert/strict";
import test from "node:test";
import { githubTriggerEvent } from "../src/automation-triggers.ts";
import { triggerNote } from "../src/relay-authority-scheduled-message-delivery.ts";

const repository = { full_name: "acme/widgets", default_branch: "main" };
const installation = { id: 42 };

test("a merged pull request and a failed workflow are trigger events; other webhooks are not", () => {
  assert.deepEqual(githubTriggerEvent("pull_request", { action: "closed", installation, repository,
    pull_request: { number: 9, merged: true, title: "Split the router", base: { ref: "main" },
      html_url: "https://github.com/acme/widgets/pull/9" } }), {
    repository: "acme/widgets", defaultBranch: "main", installationId: "42", kind: "merged", branch: "main",
    pullRequest: 9, id: "github:acme/widgets#9:merged", summary: "Pull request #9 “Split the router” was merged into main",
    url: "https://github.com/acme/widgets/pull/9" });
  assert.equal(githubTriggerEvent("pull_request", { action: "closed", installation, repository,
    pull_request: { number: 9, merged: false, base: { ref: "main" } } }), undefined);
  assert.equal(githubTriggerEvent("workflow_run", { action: "completed", installation, repository,
    workflow_run: { id: 5, name: "CI", conclusion: "success", head_branch: "main" } }), undefined);
  assert.equal(githubTriggerEvent("workflow_run", { action: "completed", installation, repository,
    workflow_run: { id: 5, run_attempt: 2, name: "CI", conclusion: "failure", head_branch: "main" } })?.id,
  "github:run:5:2");
  assert.equal(githubTriggerEvent("issues", { action: "opened", installation, repository }), undefined);
});

test("an occurrence's message names the events that fired it, and only safe links", () => {
  assert.equal(triggerNote([]), "");
  assert.equal(triggerNote([
    { summary: "Pull request #9 was merged into main", url: "https://github.com/acme/widgets/pull/9" },
    { summary: "A claim on #ui was released", url: "javascript:alert(1)" },
    { url: "https://example.com" },
  ]), "Triggered by:\n- Pull request #9 was merged into main (https://github.com/acme/widgets/pull/9)\n" +
    "- A claim on #ui was released");
});
