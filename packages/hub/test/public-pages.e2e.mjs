import {
  startMockUserHubWorker,
  createSpace,
  json,
  MOCK_TOKEN,
  randomUUID
} from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// A published page is readable by anyone, without signing in, while every
// member may read it; publishing is an owner's or admin's act.
test("an owner publishes a page, anyone reads it, and a page that is not public is not found", async () => {
  const userId = `public-pages-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "public-pages@example.com", name: "Public Pages" });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const space = await createSpace(worker, `Public ${randomUUID()}`);
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const create = async (title, extra = {}) => (await json(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title, body: `# ${title}\n\nWhere it stands.\n`, ...extra }) }))).page;
    const roadmap = await create("Roadmap");
    const finance = await create("Finance", { accessMode: "restricted" });
    const publicUrl = (pageId) => `/api/public/spaces/${encodeURIComponent(space.id)}/pages/${encodeURIComponent(pageId)}`;
    const publish = (pageId, published) => worker.fetch(`${pages}/${encodeURIComponent(pageId)}/publication`, {
      method: "PUT", headers: auth, body: JSON.stringify({ published }) });

    assert.equal((await worker.fetch(publicUrl(roadmap.pageId))).status, 404, "not public until published");
    const nowhere = await worker.fetch(`/api/public/spaces/${randomUUID()}/pages/${randomUUID()}`);
    assert.equal(nowhere.status, 404, "a page in no such Space is not found either");
    assert.equal((await nowhere.json()).code, "page_not_found");
    const published = await publish(roadmap.pageId, true);
    assert.equal(published.status, 200, await published.clone().text());
    assert.equal(typeof (await published.json()).page.publishedAt, "string");

    // No credentials at all.
    const anonymous = await worker.fetch(publicUrl(roadmap.pageId));
    assert.equal(anonymous.status, 200, await anonymous.clone().text());
    assert.match(anonymous.headers.get("cache-control"), /public/u);
    const body = await anonymous.json();
    assert.equal(body.page.title, "Roadmap");
    assert.equal(body.page.body, "# Roadmap\n\nWhere it stands.\n");
    assert.deepEqual(body.present, []);

    const refused = await publish(finance.pageId, true);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "page_not_publishable");

    assert.equal((await publish(roadmap.pageId, false)).status, 200);
    assert.equal((await worker.fetch(publicUrl(roadmap.pageId))).status, 404, "taken down, it is gone");
  } finally {
    await worker.stop();
  }
});
