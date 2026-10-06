import {
  startMockUserHubWorker,
  createSpace,
  json,
  MOCK_TOKEN,
  randomUUID
} from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// Open-project governance through the Hub: the owner opens the project and
// names its governance page, anyone reads that, the public page offers to
// join, and joining never lowers a member's role.
test("an owner opens a project; anyone can see it is open, and joining keeps a member's role", async () => {
  const userId = `governance-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "governance@example.com", name: "Governance" });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const space = await createSpace(worker, `Open ${randomUUID()}`);
    const route = `/api/spaces/${encodeURIComponent(space.id)}/governance`;
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const rules = (await json(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title: "Governance", body: "# Governance\n\nBe kind.\n" }) }))).page;

    assert.deepEqual(await json(await worker.fetch(route)), { openParticipation: false, governancePageId: null },
      "anyone reads how the project is run");
    const opened = await worker.fetch(route, { method: "PUT", headers: auth,
      body: JSON.stringify({ openParticipation: true, governancePageId: rules.pageId }) });
    assert.equal(opened.status, 200, await opened.clone().text());
    assert.deepEqual(await json(await worker.fetch(route)), { openParticipation: true, governancePageId: rules.pageId });

    const joined = await worker.fetch(`${route}/participation`, { method: "POST", headers: auth, body: "{}" });
    assert.deepEqual(await json(joined), { role: "owner" }, "joining never lowers a member's role");

    await worker.fetch(`${pages}/${encodeURIComponent(rules.pageId)}/publication`, { method: "PUT", headers: auth,
      body: JSON.stringify({ published: true }) });
    const publicPage = await json(await worker.fetch(
      `/api/public/spaces/${encodeURIComponent(space.id)}/pages/${encodeURIComponent(rules.pageId)}`));
    assert.equal(publicPage.page.openToJoin, true, "the public page offers to take part");
  } finally {
    await worker.stop();
  }
});
