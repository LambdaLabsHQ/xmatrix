import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSpace, json, MOCK_TOKEN, randomUUID, startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";

// A file pasted into a page is the Space's private content: a page shows it to
// whoever can read the page, only when the page shows it (or it was pasted into
// that very page and not saved yet), and never another Space's bytes by hash.
test("a page serves only media it shows and its Space holds, in part when asked", async () => {
  const worker = await startMockUserHubWorker({ id: `page-media-${randomUUID()}`, email: "page-media@example.com",
    name: "Page Media" });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const bytes = Buffer.from(`\x89PNG page media ${randomUUID()}`);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const file = `${hash}.png`;
    const reference = `![shot.png](xmatrix:page-media/${file})`;
    const space = await createSpace(worker, `Media ${randomUUID()}`);
    const other = await createSpace(worker, `Elsewhere ${randomUUID()}`);
    const pages = (spaceId) => `/api/spaces/${encodeURIComponent(spaceId)}/pages`;
    const create = async (spaceId, title, body) => (await json(await worker.fetch(pages(spaceId), { method: "POST",
      headers: auth, body: JSON.stringify({ title, body }) }))).page;
    const pasted = await create(space.id, "Pasted", "Nothing saved yet.\n");
    const copied = await create(space.id, "Copied", `${reference}\n`);
    const foreign = await create(other.id, "Foreign", `${reference}\n`);
    const media = (spaceId, pageId, name = file, headers = auth) =>
      worker.fetch(`${pages(spaceId)}/${encodeURIComponent(pageId)}/media/${name}`, { headers });
    const refused = async (response, status, code) => {
      assert.equal(response.status, status, await response.clone().text());
      if (code) assert.equal((await response.json()).code, code);
    };

    await refused(await media(space.id, pasted.pageId), 404, "page_media_not_found");
    const scope = `space:${space.id}`;
    const intent = await json(await worker.fetch("/api/relay-v2/private-r2/upload-intents", { method: "POST",
      headers: auth, body: JSON.stringify({ requestId: `request-${randomUUID()}`, intentId: `intent-${randomUUID()}`,
        visibilityScopeId: scope, contentHash: hash, encodedSize: bytes.length,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }) }));
    const uploaded = await worker.fetch(intent.upload.finalPath, { method: "PUT", body: bytes, headers: {
      authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "image/png", "content-length": String(bytes.length),
      "x-xmatrix-content-sha256": hash } });
    assert.equal(uploaded.status, 200, await uploaded.text());
    await json(await worker.fetch("/api/relay-v2/private-r2/blob-refs", { method: "POST", headers: auth,
      body: JSON.stringify({ requestId: `ref-${randomUUID()}`, intentId: intent.intentId,
        refId: `page-media:${pasted.pageId}:${hash}`, ownerKind: "page_media", ownerId: pasted.pageId,
        visibilityScopeId: scope }) }));

    const unsaved = await media(space.id, pasted.pageId);
    assert.equal(unsaved.status, 200, "the page it was pasted into shows it before the page saves");
    assert.equal(unsaved.headers.get("content-type"), "image/png");
    assert.equal(unsaved.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await unsaved.arrayBuffer()), bytes);
    const part = await media(space.id, copied.pageId, file, { ...auth, range: "bytes=0-3" });
    assert.equal(part.status, 206, "another page of the Space shows it once its text does");
    assert.equal(part.headers.get("content-range"), `bytes 0-3/${bytes.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(0, 4));

    await refused(await media(other.id, foreign.pageId), 404, "page_media_not_found");
    await refused(await media(space.id, copied.pageId, `${hash}.svg`), 400, "invalid_request");
    await refused(await media(space.id, pasted.pageId, file, {}), 401);

    const publicMedia = (pageId) => worker.fetch(
      `/api/public/spaces/${encodeURIComponent(space.id)}/pages/${encodeURIComponent(pageId)}/media/${file}`);
    await refused(await publicMedia(copied.pageId), 404, "page_not_found");
    for (const page of [copied, pasted]) {
      const published = await worker.fetch(`${pages(space.id)}/${encodeURIComponent(page.pageId)}/publication`,
        { method: "PUT", headers: auth, body: JSON.stringify({ published: true }) });
      assert.equal(published.status, 200, await published.clone().text());
    }
    const shown = await publicMedia(copied.pageId);
    assert.equal(shown.status, 200, await shown.clone().text());
    assert.match(shown.headers.get("cache-control"), /public/u);
    await refused(await publicMedia(pasted.pageId), 404, "page_media_not_found");
  } finally {
    await worker.stop();
  }
});
