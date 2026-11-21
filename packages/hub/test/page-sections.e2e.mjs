import {
  startMockUserHubWorker,
  createSpace,
  json,
  MOCK_TOKEN,
  randomUUID
} from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// A large page is read a level at a time (its outline, then one section) and a section is written
// back as a section: the rest of the page stays, including what others changed since the read.
test("a page is read by outline and section, and a section edit leaves the rest of the page", async () => {
  const userId = `page-sections-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "page-sections@example.com", name: "Sections" });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const space = await createSpace(worker, `Sections ${randomUUID()}`);
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const page = (await json(await worker.fetch(pages, { method: "POST", headers: auth, body: JSON.stringify({
      title: "Relay", body: "# Relay\n\n## Status\n\nIn progress\n\n### Risks\n\nnone\n\n## Notes\n\n- none\n" }) }))).page;
    const at = `${pages}/${encodeURIComponent(page.pageId)}`;
    const put = (body) => worker.fetch(at, { method: "PUT", headers: auth, body: JSON.stringify(body) });

    const outlined = await json(await worker.fetch(`${at}?outline=1`, { headers: auth }));
    assert.equal(outlined.page.body, "", "an outline carries no text");
    assert.deepEqual(outlined.outline.map((entry) => [entry.id, entry.depth]),
      [["relay", 1], ["status", 2], ["risks", 3], ["notes", 2]]);

    const status = await json(await worker.fetch(`${at}?section=status`, { headers: auth }));
    assert.deepEqual(status.section, { id: "status", title: "Status" });
    assert.equal(status.page.body, "## Status\n\nIn progress\n\n### Risks\n\nnone\n\n", "deeper headings come with it");
    assert.equal(status.page.headRevision, 1);
    assert.equal((await worker.fetch(`${at}?section=absent`, { headers: auth })).status, 404);

    // Someone else changes Notes after the read; the section edit is still based on revision 1.
    const others = await put({ baseRevision: 1, body: "# Relay\n\n## Status\n\nIn progress\n\n### Risks\n\nnone\n\n## Notes\n\n- see the runbook\n" });
    assert.equal(others.status, 200, await others.clone().text());

    const edited = await put({ baseRevision: 1, sectionId: "status", body: "## Status\n\nShipped\n\n### Risks\n\nnone\n" });
    assert.equal(edited.status, 200, await edited.clone().text());
    const { page: read } = await json(await worker.fetch(at, { headers: auth }));
    assert.equal(read.body, "# Relay\n\n## Status\n\nShipped\n\n### Risks\n\nnone\n\n## Notes\n\n- see the runbook\n",
      "the section is rewritten and the other edit is kept");

    const headless = await put({ baseRevision: read.headRevision, sectionId: "notes", body: "- just the list\n" });
    assert.equal(headless.status, 400, "a section's text starts with its heading");
    const absent = await put({ baseRevision: read.headRevision, sectionId: "absent", body: "## Absent\n\nx\n" });
    assert.equal(absent.status, 404);
    assert.equal((await json(await worker.fetch(at, { headers: auth }))).page.body, read.body, "a refused edit writes nothing");
  } finally {
    await worker.stop();
  }
});
