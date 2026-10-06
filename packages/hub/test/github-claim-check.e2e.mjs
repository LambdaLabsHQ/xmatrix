import { deliverGitHubWebhook, withGitHubUserScenario } from "./support/github-user-worker.mjs";
import {
  createSpace,
  json,
  randomUUID
} from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { connectGitHubInstallation, inWorkerTransaction } from "./registration-launch.fixture.mjs";

const installationId = "claim-installation";
const secret = "claim-webhook-secret";

/** GitHub's API as the claim check uses it: the repository's installation, a token, and check runs. */
function githubConfiguration() {
  return { installationId, repository: "acme/widgets", permissions: { metadata: "read", checks: "write" } };
}

// The claim check end to end: a pull request that links a page block passes
// only when its author, through their linked GitHub account, holds a claim on
// it, and merging it completes the claim.
test("a pull request passes xmatrix/claim when its author holds the claim, and merging completes it", async () => {
  const userId = `claim-check-${randomUUID()}`;
  await withGitHubUserScenario({ id: userId, email: "claim-check@example.com", name: "Claim Check" }, githubConfiguration(), secret,
    async ({ worker, github, auth }) => {
    const space = await createSpace(worker, `Claims ${randomUUID()}`);
    await connectGitHubInstallation(worker, { spaceId: space.id, userId, installationId });
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const page = (await json(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title: "Roadmap", body: "# Roadmap\n\n## Search\n\nNext.\n" }) }))).page;
    const link = `https://xmatrix.sh/app/${space.id}/pages?page=${page.pageId}#search`;
    const pullUrl = "https://github.com/acme/widgets/pull/7";

    let delivery = 0;
    const deliver = async (action, pull = {}) => {
      const body = JSON.stringify({ action, installation: { id: installationId },
        repository: { full_name: "acme/widgets" },
        pull_request: { html_url: pullUrl, body: `Implements ${link}`, user: { id: 4242, login: "alice" },
          head: { sha: `sha-${delivery}` }, merged: false, ...pull } });
      const response = await deliverGitHubWebhook(worker, { body, event: "pull_request", deliveryId: `d-${++delivery}`, secret });
      assert.equal(response.status, 200, await response.clone().text());
      return github.checkRuns.at(-1);
    };

    const unlinked = await deliver("opened");
    assert.equal(unlinked.name, "xmatrix/claim");
    assert.equal(unlinked.conclusion, "failure");
    assert.equal(unlinked.output.title, "GitHub account not linked to xMatrix");

    // The author links their GitHub account; they have not claimed the block yet.
    await inWorkerTransaction(worker, async (tx) => {
      await tx.query({ text: `INSERT INTO control.auth_users (id,name,email,created_at,updated_at)
        VALUES ($1,'Claim Check','claim-check@example.com',now(),now()) ON CONFLICT DO NOTHING`, values: [userId] });
      await tx.query({ text: `INSERT INTO control.auth_accounts (id,account_id,provider_id,user_id,created_at,updated_at)
        VALUES ($1,'4242','github',$2,now(),now())`, values: [randomUUID(), userId] });
    });
    const unclaimed = await deliver("synchronize");
    assert.equal(unclaimed.conclusion, "failure");
    assert.equal(unclaimed.output.title, "No claim on the referenced block");
    assert.equal(unclaimed.head_sha, "sha-1");

    const claims = `${pages}/${encodeURIComponent(page.pageId)}/claims`;
    const { claim } = await json(await worker.fetch(claims, { method: "POST", headers: auth,
      body: JSON.stringify({ blockId: "search" }) }));
    const passed = await deliver("edited");
    assert.equal(passed.conclusion, "success");
    assert.equal(passed.output.title, "Claim Check holds Roadmap › #search");
    assert.match(passed.details_url, new RegExp(`page=${page.pageId}#search$`, "u"));
    const listed = await json(await worker.fetch(claims, { headers: auth }));
    assert.equal(listed.claims[0].pullRequestUrl, pullUrl, "the claim records the pull request doing its work");

    await deliver("closed", { merged: true });
    assert.deepEqual((await json(await worker.fetch(claims, { headers: auth }))).claims, [],
      "merging completes the claim");
    const [row] = await inWorkerTransaction(worker, (tx) => tx.query({
      text: "SELECT state FROM data.page_claims WHERE space_id=$1 AND claim_id=$2", values: [space.id, claim.claimId] }));
    assert.equal(row.state, "completed");
    // The merge did the claimed work, so the section owes an update until it is written back.
    const awareness = await json(await worker.fetch(`${pages}/${encodeURIComponent(page.pageId)}/awareness`,
      { headers: auth }));
    assert.deepEqual((({ reason, pullRequestUrl }) => ({ reason, pullRequestUrl }))(
      awareness.blocks.find((block) => block.blockId === "search").owed), { reason: "merged", pullRequestUrl: pullUrl });

    const before = github.checkRuns.length;
    await deliver("opened", { body: "No page link here" });
    assert.equal(github.checkRuns.length, before, "a pull request that names no block gets no check");
  });
});
