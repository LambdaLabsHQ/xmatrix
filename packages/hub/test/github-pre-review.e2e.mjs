import { deliverGitHubWebhook, withGitHubUserScenario, registeredGitHubPageAgent } from "./support/github-user-worker.mjs";
import {
  admitRegisteredSpawn,
  json,
  randomUUID
} from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { connectGitHubInstallation, inWorkerTransaction } from "./registration-launch.fixture.mjs";

const installationId = "pre-review-installation";
const secret = "pre-review-webhook-secret";

/** GitHub's API as pre-review reads it, with the check runs it receives. */
function githubConfiguration() {
  const routes = {
    "/repos/acme/widgets/pulls/7": { number: 7, title: "Search by prefix", body: "Implements search.",
      draft: false, head: { sha: "head-2" }, user: { login: "alice" } },
    "/repos/acme/widgets/pulls/7/files?per_page=100": [{ filename: "src/search.ts", status: "modified",
      additions: 3, deletions: 1, patch: "@@ -1 +1,3 @@\n-exact\n+prefix" }],
    "/repos/acme/widgets/commits/head-2/check-runs?per_page=100": { check_runs: [
      { name: "ci", status: "completed", conclusion: "success" },
      { name: "xmatrix/claim", status: "completed", conclusion: "success" }] },
    "/repos/acme/widgets/pulls?state=open&per_page=50": [
      { number: 7, title: "Search by prefix", html_url: "https://github.com/acme/widgets/pull/7" },
      { number: 8, title: "Fuzzy search", html_url: "https://github.com/acme/widgets/pull/8" }],
  };
  return { installationId, repository: "acme/widgets",
    permissions: { metadata: "read", checks: "write", pull_requests: "read" }, routes };
}

// Pre-review end to end: a claimed pull request gets a review conversation on
// its block, an Agent of the Space owner's is launched there with the change,
// and its verdict becomes the xmatrix/pre-review check on the head it reviewed.
test("a claimed pull request is pre-reviewed by an Agent in its own conversation on the block", async () => {
  const userId = `pre-review-${randomUUID()}`;
  const configuration = githubConfiguration();
  await withGitHubUserScenario({ id: userId, email: "pre-review@example.com", name: "Pre Review" }, configuration, secret,
    async ({ worker, github, auth }) => {
  let daemon;
  try {
    const registered = await registeredGitHubPageAgent(worker, userId, auth, { slug: "review", displayName: "reviewer" });
    ({ daemon } = registered);
    const { home, spaceId } = registered;

    await connectGitHubInstallation(worker, { spaceId, userId, installationId });
    await inWorkerTransaction(worker, async (tx) => {
      await tx.query({ text: `INSERT INTO control.auth_users (id,name,email,created_at,updated_at)
        VALUES ($1,'Pre Review','pre-review@example.com',now(),now()) ON CONFLICT DO NOTHING`, values: [userId] });
      await tx.query({ text: `INSERT INTO control.auth_accounts (id,account_id,provider_id,user_id,created_at,updated_at)
        VALUES ($1,'5151','github',$2,now(),now())`, values: [randomUUID(), userId] });
    });
    const pages = `/api/spaces/${encodeURIComponent(spaceId)}/pages`;
    const page = (await json(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title: "Roadmap", body: "# Roadmap\n\n## Search\n\nPrefix search.\n" }) }))).page;
    await json(await worker.fetch(`${pages}/${encodeURIComponent(page.pageId)}/claims`, { method: "POST",
      headers: auth, body: JSON.stringify({ blockId: "search" }) }));

    const spawn = daemon.inbox.waitFor((message) => message.type === "machine_spawn_agent"
      && message.channelId !== home.id, "pre-review spawn");
    const body = JSON.stringify({ action: "opened", installation: { id: installationId },
      repository: { full_name: "acme/widgets" },
      pull_request: { number: 7, html_url: "https://github.com/acme/widgets/pull/7", draft: false,
        body: `Implements https://xmatrix.sh/app/${spaceId}/pages?page=${page.pageId}#search`,
        user: { id: 5151, login: "alice" }, head: { sha: "head-1" } } });
    const delivered = await deliverGitHubWebhook(worker, { body, event: "pull_request", deliveryId: randomUUID(), secret });
    assert.equal(delivered.status, 200, await delivered.clone().text());
    assert.equal(github.checkRuns.find((run) => run.name === "xmatrix/claim")?.conclusion, "success");

    const command = await spawn;
    assert.match(command.prompt, /Pre-review pull request https:\/\/github\.com\/acme\/widgets\/pull\/7/u);
    assert.match(command.prompt, /Search by prefix/u);
    assert.match(command.prompt, /#8 Fuzzy search/u, "the reviewer sees the other open pull requests");
    assert.match(command.prompt, /- ci: success/u);
    assert.doesNotMatch(command.prompt, /xmatrix\/claim:/u, "its own checks are not review input");
    const links = await json(await worker.fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/page-links?pageId=${encodeURIComponent(page.pageId)}`, { headers: auth }));
    assert.ok(links.links.some((link) => link.conversationId === command.channelId && link.blockId === "search"),
      "the review conversation is on the block");

    const runToken = await admitRegisteredSpawn(worker, daemon, command);
    const postVerdict = () => worker.fetch(`/api/channels/${encodeURIComponent(command.channelId)}/pre-review`, {
      method: "POST", headers: { Authorization: `Bearer ${runToken}`, "content-type": "application/json" },
      body: JSON.stringify({ verdict: "pass", summary: "In scope, tested, no duplicate." }) });

    // A push lands while the Agent reviews head-2: its verdict is not moved
    // onto the unreviewed head-3, and nothing is published.
    const pullRoute = "/repos/acme/widgets/pulls/7";
    const reviewed = configuration.routes[pullRoute];
    configuration.routes[pullRoute] = { ...reviewed, head: { sha: "head-3" } };
    const moved = await postVerdict();
    assert.equal(moved.status, 409, await moved.clone().text());
    assert.equal((await moved.json()).code, "pre_review_head_moved");
    assert.equal(github.checkRuns.some((run) => run.name === "xmatrix/pre-review"), false,
      "no verdict is published on a head the Agent did not review");
    configuration.routes[pullRoute] = reviewed;

    const verdict = await postVerdict();
    assert.equal(verdict.status, 200, await verdict.clone().text());
    const published = github.checkRuns.find((run) => run.name === "xmatrix/pre-review");
    assert.equal(published.conclusion, "success");
    assert.equal(published.head_sha, "head-2", "the verdict lands on the head commit that was reviewed");
    assert.match(published.output.summary, /In scope, tested, no duplicate\./u);

    const human = await worker.fetch(`/api/channels/${encodeURIComponent(command.channelId)}/pre-review`, {
      method: "POST", headers: auth, body: JSON.stringify({ verdict: "pass", summary: "LGTM" }) });
    assert.equal(human.status, 403, "the verdict is the reviewing Agent's");
  } finally { daemon?.ws?.close(); }
  });
});
