import { deliverGitHubWebhook, withGitHubUserScenario } from "./support/github-user-worker.mjs";
import {
  randomUUID
} from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { connectGitHubInstallation, inWorkerTransaction } from "./registration-launch.fixture.mjs";

const installationId = "trigger-installation";
const secret = "trigger-webhook-secret";

/** GitHub's API as triggers use it: the repository's installation, a token, and a pull request's files. */
function githubConfiguration() {
  const files = { 9: ["packages/hub/src/index.ts", "README.md"], 10: ["docs/notes.md"], 14: ["packages/hub/src/x.ts"] };
  return { installationId, repository: "acme/widgets",
    permissions: { metadata: "read", pull_requests: "read" },
    routes: Object.fromEntries(Object.entries(files).map(([number, names]) => [
      `/repos/acme/widgets/pulls/${number}/files?per_page=100&page=1`, names.map((filename) => ({ filename }))])) };
}

// Events fire a page's Automations (docs/design/pages-live-document.md §6.2):
// a merged pull request touching its paths, a failed workflow, a section
// starting to owe an update. Each makes it due now and is recorded once.
test("merges, failed workflows and owed sections fire a page's Automation, each once", async () => {
  const userId = `trigger-${randomUUID()}`;
  await withGitHubUserScenario({ id: userId, email: "trigger@example.com", name: "Trigger Owner" }, githubConfiguration(), secret,
    async ({ worker, auth }) => {
    const call = async (path, method = "GET", body, status = 200) => {
      const response = await worker.fetch(path, { method, headers: auth,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      assert.equal(response.status, status, await response.clone().text());
      return response.json();
    };
    const space = (await call("/api/spaces", "POST", { name: `Triggers ${randomUUID()}` })).space;
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const page = (await call(pages, "POST", { title: "Goals",
      body: "# Goals\n\n## Architecture\n\nNo bloat.\n\n## UI\n\nConsistent.\n" })).page;
    const automations = `${pages}/${encodeURIComponent(page.pageId)}/automations`;
    const create = (triggers, status = 201) => call(automations, "POST", { name: "Code audit",
      instruction: "Audit what changed", intervalMinutes: 720, blockId: "architecture", triggers }, status);

    const unconnected = await create([{ kind: "merged", repository: "acme/widgets" }], 409);
    assert.equal(unconnected.code, "github_connection_required");
    await connectGitHubInstallation(worker, { spaceId: space.id, userId, installationId });
    assert.equal((await create([{ kind: "merged", repository: "someone/else" }], 409)).code,
      "github_repository_not_connected");
    assert.equal((await create([{ kind: "nightly" }], 400)).code, "invalid_trigger");

    const { automation } = await create([
      { kind: "merged", repository: "acme/widgets", paths: ["packages/hub"] },
      { kind: "ci-failed", repository: "acme/widgets", workflow: "CI" },
      { kind: "owed" },
    ]);
    assert.deepEqual(automation.triggers, [
      { kind: "merged", repository: "acme/widgets", paths: ["packages/hub"], installationId },
      { kind: "ci-failed", repository: "acme/widgets", workflow: "CI", installationId },
      { kind: "owed" },
    ]);
    const events = async () => ((await call(automations)).automations.find((item) => item.id === automation.id)
      .triggerEvents ?? []).map((event) => event.summary);

    let delivery = 0;
    const deliver = async (event, payload, from = installationId) => {
      const body = JSON.stringify({ installation: { id: from },
        repository: { full_name: "acme/widgets", default_branch: "main" }, ...payload });
      const response = await deliverGitHubWebhook(worker, { body, event: event, deliveryId: `d-${++delivery}`, secret });
      assert.equal(response.status, 200, await response.clone().text());
    };
    const merged = (number, branch = "main") => ({ action: "closed", pull_request: { number, merged: true,
      title: `Change ${number}`, html_url: `https://github.com/acme/widgets/pull/${number}`, base: { ref: branch },
      user: { id: 1 }, head: { sha: "abc" }, body: "" } });

    await deliver("pull_request", merged(9));
    assert.deepEqual(await events(), ["Pull request #9 “Change 9” was merged into main"]);
    const [row] = await inWorkerTransaction(worker, (tx) => tx.query({
      text: "SELECT next_run_at <= now() AS due FROM data.automations WHERE automation_id=$1", values: [automation.id] }));
    assert.equal(row.due, true, "the event makes it due now");
    await deliver("pull_request", merged(9));
    assert.equal((await events()).length, 1, "a redelivered event fires nothing more");
    // Events run it at most hourly, so its own fixes cannot keep re-running it.
    await inWorkerTransaction(worker, (tx) => tx.query({ text: `UPDATE data.automations
      SET last_run_at=now(), next_run_at=now()+interval '12 hours' WHERE automation_id=$1`, values: [automation.id] }));
    await deliver("pull_request", merged(14));
    const [spaced] = await inWorkerTransaction(worker, (tx) => tx.query({ text: `SELECT
      next_run_at BETWEEN now()+interval '55 minutes' AND now()+interval '65 minutes' AS hourly
      FROM data.automations WHERE automation_id=$1`, values: [automation.id] }));
    assert.equal(spaced.hourly, true);
    assert.equal((await events()).length, 2);
    await deliver("pull_request", merged(11, "dev"));
    await deliver("pull_request", merged(10));
    await deliver("pull_request", merged(12), "someone-elses-installation");
    assert.equal((await events()).length, 2, "another branch, other paths or another installation fire nothing");

    const run = (name, conclusion) => ({ action: "completed", workflow_run: { id: 77, run_attempt: 1, name,
      conclusion, head_branch: "main", html_url: "https://github.com/acme/widgets/actions/runs/77" } });
    await deliver("workflow_run", run("CI", "success"));
    await deliver("workflow_run", run("Deploy", "failure"));
    assert.equal((await events()).length, 2);
    await deliver("workflow_run", run("CI", "failure"));
    assert.equal((await events()).at(-1), "Workflow “CI” failed on main");

    // A claim released on its section leaves the section owing an update.
    const claims = `${pages}/${encodeURIComponent(page.pageId)}/claims`;
    const { claim } = await call(claims, "POST", { blockId: "architecture" });
    await call(`${claims}/${encodeURIComponent(claim.claimId)}`, "DELETE");
    assert.equal((await events()).at(-1), "A claim on #architecture was released, so it owes an update");
    const { claim: other } = await call(claims, "POST", { blockId: "ui" });
    await call(`${claims}/${encodeURIComponent(other.claimId)}`, "DELETE");
    assert.equal((await events()).length, 4, "a section it is not in fires nothing");
  });
});
