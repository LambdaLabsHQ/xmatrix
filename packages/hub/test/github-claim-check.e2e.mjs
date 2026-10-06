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

/** A Space connected to the claim installation, with a Roadmap page whose Search block a pull request links. */
async function roadmapSpace(worker, { userId, auth }) {
  const space = await createSpace(worker, `Claims ${randomUUID()}`);
  await connectGitHubInstallation(worker, { spaceId: space.id, userId, installationId });
  const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
  const page = (await json(await worker.fetch(pages, { method: "POST", headers: auth,
    body: JSON.stringify({ title: "Roadmap", body: "# Roadmap\n\n## Search\n\nNext.\n" }) }))).page;
  return { pages, page, link: `https://xmatrix.sh/app/${space.id}/pages?page=${page.pageId}#search`, space };
}

/** The person links their GitHub account (`githubId`) to xMatrix. */
function linkGitHubAccount(worker, { userId, name, email, githubId }) {
  return inWorkerTransaction(worker, async (tx) => {
    await tx.query({ text: `INSERT INTO control.auth_users (id,name,email,created_at,updated_at)
      VALUES ($1,$2,$3,now(),now()) ON CONFLICT DO NOTHING`, values: [userId, name, email] });
    await tx.query({ text: `INSERT INTO control.auth_accounts (id,account_id,provider_id,user_id,created_at,updated_at)
      VALUES ($1,$2,'github',$3,now(),now())`, values: [randomUUID(), githubId, userId] });
  });
}

// The claim check end to end: a pull request that links a page block passes
// only when its author, through their linked GitHub account, holds a claim on
// it, and merging it completes the claim.
test("a pull request passes xmatrix/claim when its author holds the claim, and merging completes it", async () => {
  const userId = `claim-check-${randomUUID()}`;
  await withGitHubUserScenario({ id: userId, email: "claim-check@example.com", name: "Claim Check" }, githubConfiguration(), secret,
    async ({ worker, github, auth }) => {
    const { pages, page, link, space } = await roadmapSpace(worker, { userId, auth });
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
    await linkGitHubAccount(worker, { userId, name: "Claim Check", email: "claim-check@example.com", githubId: "4242" });
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

// A pull request carries a claim only from an installation the claim's Space
// connected: the same author, linking the same block, from another
// installation (or a delivery naming none) neither attaches to the claim nor
// completes it, and the section owes nothing.
test("a pull request from an installation the Space did not connect neither attaches to nor completes its claim", async () => {
  const userId = `claim-foreign-${randomUUID()}`;
  await withGitHubUserScenario({ id: userId, email: "claim-foreign@example.com", name: "Claim Foreign" }, githubConfiguration(), secret,
    async ({ worker, github, auth }) => {
    const { pages, page, link, space } = await roadmapSpace(worker, { userId, auth });
    await linkGitHubAccount(worker, { userId, name: "Claim Foreign", email: "claim-foreign@example.com", githubId: "4343" });
    const claims = `${pages}/${encodeURIComponent(page.pageId)}/claims`;
    const { claim } = await json(await worker.fetch(claims, { method: "POST", headers: auth,
      body: JSON.stringify({ blockId: "search" }) }));

    let delivery = 0;
    const deliver = async (action, { installation, repository = "acme/widgets", pullUrl, ...pull }) => {
      const body = JSON.stringify({ action, ...(installation === undefined ? {} : { installation: { id: installation } }),
        repository: { full_name: repository },
        pull_request: { html_url: pullUrl, body: `Implements ${link}`, user: { id: 4343, login: "mallory" },
          head: { sha: `sha-${delivery}` }, merged: false, ...pull } });
      const response = await deliverGitHubWebhook(worker, { body, event: "pull_request", deliveryId: `f-${++delivery}`, secret });
      assert.equal(response.status, 200, await response.clone().text());
    };
    const state = async () => (await inWorkerTransaction(worker, (tx) => tx.query({
      text: "SELECT state, pull_request_url FROM data.page_claims WHERE space_id=$1 AND claim_id=$2",
      values: [space.id, claim.claimId] })))[0];
    const owed = async () => (await json(await worker.fetch(`${pages}/${encodeURIComponent(page.pageId)}/awareness`,
      { headers: auth }))).blocks.find((block) => block.blockId === "search")?.owed ?? null;

    // From a foreign installation, or a delivery naming none: no attach, no check.
    const foreignUrl = "https://github.com/mallory/elsewhere/pull/1";
    await deliver("opened", { installation: "foreign-installation", repository: "mallory/elsewhere", pullUrl: foreignUrl });
    await deliver("opened", { installation: undefined, repository: "mallory/elsewhere", pullUrl: foreignUrl });
    assert.equal(github.checkRuns.length, 0, "no claim check is published for another installation's pull request");
    assert.deepEqual({ ...await state() }, { state: "active", pull_request_url: null }, "the claim does not attach");

    // Once the Space's own pull request attached, a merge another installation reports still completes nothing.
    const pullUrl = "https://github.com/acme/widgets/pull/9";
    await deliver("opened", { installation: installationId, pullUrl });
    assert.equal(github.checkRuns.at(-1).conclusion, "success");
    assert.deepEqual({ ...await state() }, { state: "active", pull_request_url: pullUrl });
    await deliver("closed", { installation: "foreign-installation", pullUrl, merged: true });
    await deliver("closed", { installation: undefined, pullUrl, merged: true });
    assert.equal((await state()).state, "active", "a foreign installation's merge does not complete the claim");
    assert.equal(await owed(), null, "and the section owes no update");

    // The Space's own installation still completes it.
    await deliver("closed", { installation: installationId, pullUrl, merged: true });
    assert.equal((await state()).state, "completed");
    assert.equal((await owed())?.reason, "merged");
  });
});
