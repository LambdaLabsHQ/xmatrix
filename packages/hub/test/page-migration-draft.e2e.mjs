import assert from "node:assert/strict";
import test from "node:test";
import {
  inTestTransaction, json, launchMentionedCodexRun, MOCK_TOKEN, randomUUID, startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";

// The move to pages end to end: a launched Agent Run of the Space owner reads
// the Space and submits a drafted page tree as itself; the owner reviews and
// applies it; the pages carry the Agent as their author and link their sources.
test("a launched Agent Run drafts the move to pages and the owner applies it", async () => {
  const userId = `page-migration-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "page-migration@example.com", XMATRIX_MOCK_AUTH_NAME: "Page Migration",
  } });
  let daemon;
  let agent;
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const unique = randomUUID();
    const run = await launchMentionedCodexRun(worker, { ownerUserId: userId, slug: "migration", displayName: "drafter",
      mention: "@codex draft this Space's move to pages" });
    ({ daemon, agent } = run);
    const { command, channel, spaceId, runToken } = run;

    const route = `/api/spaces/${encodeURIComponent(spaceId)}/page-migration`;
    const asRun = { Authorization: `Bearer ${runToken}`, "content-type": "application/json" };
    const none = await json(await worker.fetch(route, { headers: asRun }));
    assert.equal(none.state, "none");
    const draft = { pages: [
      { key: "roadmap", parentKey: null, title: "Roadmap", body: "# Roadmap\n\nShip pages this week.\n",
        sources: [channel.id] },
      { key: "release", parentKey: "roadmap", title: "Release", body: "# Release\n\nProduction after review.\n",
        sources: [] },
    ] };
    // The owner reads every closed conversation; this Run was never granted this one.
    const unshared = (await json(await worker.fetch("/api/channels", {
      method: "POST", headers: auth, body: JSON.stringify({ spaceId, mode: "closed", name: `board-${unique}`, access: [] }),
    }))).channel;
    const refused = await worker.fetch(`${route}/draft`, { method: "PUT", headers: asRun,
      body: JSON.stringify({ version: 0, draft: { pages: [{ ...draft.pages[0], sources: [unshared.id] }] } }) });
    assert.equal(refused.status, 403, await refused.clone().text());
    assert.equal((await refused.json()).code, "page_migration_source_forbidden");
    const submitted = await worker.fetch(`${route}/draft`, { method: "PUT", headers: asRun,
      body: JSON.stringify({ version: 0, draft }) });
    assert.equal(submitted.status, 200, await submitted.clone().text());
    const proposed = await submitted.json();
    assert.equal(proposed.state, "proposed");
    assert.equal(proposed.drafter.kind, "agent");
    assert.equal(proposed.drafter.id, command.instanceId, "the drafter is the authenticated Run's Agent");

    // The Run applies it as its owner, an admin, would.
    const reviewed = await json(await worker.fetch(route, { headers: auth }));
    assert.deepEqual(reviewed.draft.pages.map((page) => page.title), ["Roadmap", "Release"]);
    const applied = await json(await worker.fetch(`${route}/apply`, { method: "POST", headers: asRun,
      body: JSON.stringify({ version: reviewed.version }) }));
    assert.equal(applied.state, "applied");
    assert.deepEqual(applied.report, { pages: 2, links: 1, restrictedPages: 1 });
    assert.equal(applied.applied.by.kind, "agent");
    assert.equal(applied.applied.by.id, command.instanceId, "the applier is the authenticated Run's Agent");
    const confirmed = (await inTestTransaction(tx => tx.query({
      text: "SELECT confirmed_by_user_id FROM data.page_migrations WHERE space_id=$1", values: [spaceId] })))[0];
    assert.equal(confirmed.confirmed_by_user_id, null, "no human is recorded as having applied it");
    // The Run arranges the tree as its owner may: a new page, then moved to the root.
    const pagesRoute = `/api/spaces/${encodeURIComponent(spaceId)}/pages`;
    const roadmapPage = (await json(await worker.fetch(pagesRoute, { headers: auth }))).pages
      .find((page) => page.title === "Roadmap");
    const created = await worker.fetch(pagesRoute, { method: "POST", headers: asRun,
      body: JSON.stringify({ title: "Agent notes", parentPageId: roadmapPage.pageId }) });
    assert.equal(created.status, 200, await created.clone().text());
    const notes = (await created.json()).page;
    assert.equal(notes.parentPageId, roadmapPage.pageId);
    const moved = await worker.fetch(`${pagesRoute}/${encodeURIComponent(notes.pageId)}`, { method: "PATCH",
      headers: asRun, body: JSON.stringify({ parentPageId: null, title: "Notes" }) });
    assert.equal(moved.status, 200, await moved.clone().text());
    assert.deepEqual([(await moved.json()).page.parentPageId, "Notes"], [null, "Notes"]);
    // A retry, even by the owner, returns the first application unchanged.
    const again = await json(await worker.fetch(`${route}/apply`, { method: "POST", headers: auth,
      body: JSON.stringify({ version: reviewed.version }) }));
    assert.deepEqual(again.applied, applied.applied);

    const tree = await json(await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/pages`, { headers: auth }));
    const roadmap = tree.pages.find((page) => page.title === "Roadmap");
    assert.equal(roadmap.accessMode, "restricted", "written from a closed conversation");
    const read = await json(await worker.fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(roadmap.pageId)}`, { headers: auth }));
    assert.equal(read.page.body, "# Roadmap\n\nShip pages this week.\n");
    assert.deepEqual(read.page.revisionInfo.authors.map((author) => [author.kind, author.id]),
      [["agent", command.instanceId]]);
  } finally {
    agent?.ws?.close();
    daemon?.ws?.close();
    await worker.stop();
  }
});
