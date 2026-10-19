import {
  startMockUserHubWorker,
  createSpace,
  json,
  MOCK_TOKEN,
  randomUUID
} from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";

// What a reader of each section should know besides its text
// (docs/design/pages-live-document.md §3): when and where it last changed,
// and who has taken it. Edits go through the page's live session, which keeps
// the page as a document and commits canonical markdown.
test("each section says which revision last changed it, who has claimed it and what is discussed there", async () => {
  const userId = `page-awareness-${randomUUID()}`;
  const worker = await startMockUserHubWorker({ id: userId, email: "page-awareness@example.com", name: "Awareness" });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const space = await createSpace(worker, `Awareness ${randomUUID()}`);
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const page = (await json(await worker.fetch(pages, { method: "POST", headers: auth, body: JSON.stringify({
      title: "Relay", body: "# Relay\n## Status\nIn progress\n## Notes\n* none\n" }) }))).page;
    const at = `${pages}/${encodeURIComponent(page.pageId)}`;
    const edit = async (baseRevision, change) => {
      const { page: current } = await json(await worker.fetch(at, { headers: auth }));
      const response = await worker.fetch(at, { method: "PUT", headers: auth,
        body: JSON.stringify({ baseRevision, body: change(current.body) }) });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).headRevision;
    };
    const second = await edit(1, (body) => body.replace("In progress", "Shipped"));
    const third = await edit(second, (body) => body.replace("none", "see the runbook"));

    const { page: read } = await json(await worker.fetch(at, { headers: auth }));
    assert.equal(read.body, "# Relay\n\n## Status\n\nShipped\n\n## Notes\n\n- see the runbook\n",
      "the session commits the page's canonical markdown");

    // What changed since the first revision: the revisions after it and their diff, as documents.
    const changes = await json(await worker.fetch(`${at}/changes?since=1`, { headers: auth }));
    assert.deepEqual(changes.revisions.map((revision) => revision.revision), [second, third]);
    assert.deepEqual(changes.diff.filter((part) => part.kind !== "same"), [
      { kind: "removed", lines: ["In progress"] }, { kind: "added", lines: ["Shipped"] },
      { kind: "removed", lines: ["- none"] }, { kind: "added", lines: ["- see the runbook"] }]);
    assert.equal((await worker.fetch(`${at}/changes?since=0`, { headers: auth })).status, 400);

    assert.equal((await worker.fetch(`${at}/claims`, { method: "POST", headers: auth,
      body: JSON.stringify({ blockId: "notes" }) })).status, 200);
    const awareness = await json(await worker.fetch(`${at}/awareness`, { headers: auth }));
    assert.equal(awareness.headRevision, third);
    const block = (id) => awareness.blocks.find((entry) => entry.blockId === id);
    assert.equal(block("status").updated.revision, second);
    assert.equal(block("notes").updated.revision, third);
    assert.equal(block("relay").updated.revision, 1, "a section untouched since the page began");
    assert.equal(block("status").updated.authors[0].label, "Awareness");
    assert.deepEqual(block("notes").claims.map((claim) => claim.holder.label), ["Awareness"]);
    assert.deepEqual(block("status").claims, []);

    // A discussion anchored in the text is on its section until it is resolved.
    const channel = (await json(await worker.fetch("/api/channels", { method: "POST", headers: auth,
      body: JSON.stringify({ spaceId: space.id, mode: "open", name: `discuss-${randomUUID()}` }) }))).channel;
    const anchor = { quote: "Shipped", from: { type: null, tname: "prosemirror", item: null, assoc: 0 },
      to: { type: null, tname: "prosemirror", item: null, assoc: 0 } };
    const linked = await worker.fetch(`/api/spaces/${encodeURIComponent(space.id)}/page-links`, { method: "POST",
      headers: auth, body: JSON.stringify({ conversationId: channel.id, pageId: page.pageId, blockId: "status", anchor }) });
    assert.equal(linked.status, 200, await linked.clone().text());
    const { link } = await linked.json();
    assert.equal(link.anchor.quote, "Shipped");
    assert.equal(link.resolvedAt, null);
    const discussing = await json(await worker.fetch(`${at}/awareness`, { headers: auth }));
    assert.deepEqual(discussing.blocks.find((entry) => entry.blockId === "status").discussions,
      [{ linkId: link.linkId, conversationId: channel.id, quote: "Shipped" }]);
    const tooBig = await worker.fetch(`/api/spaces/${encodeURIComponent(space.id)}/page-links`, { method: "POST",
      headers: auth, body: JSON.stringify({ conversationId: channel.id, pageId: page.pageId, blockId: "notes",
        anchor: { quote: "x", from: { pad: "y".repeat(5000) }, to: {} } }) });
    assert.equal(tooBig.status, 400, "an anchor is bounded");
    const resolved = await worker.fetch(`/api/spaces/${encodeURIComponent(space.id)}/page-links/${link.linkId}/resolution`,
      { method: "PUT", headers: auth, body: JSON.stringify({ resolved: true }) });
    assert.equal(resolved.status, 200, await resolved.clone().text());
    assert.equal(typeof (await resolved.json()).link.resolvedAt, "string");
    const settled = await json(await worker.fetch(`${at}/awareness`, { headers: auth }));
    assert.deepEqual(settled.blocks.find((entry) => entry.blockId === "status").discussions, []);

    // Claimed work that ended leaves its section owing an update until the section changes.
    const claimed = await json(await worker.fetch(`${at}/claims`, { method: "POST", headers: auth,
      body: JSON.stringify({ blockId: "status" }) }));
    const released = await worker.fetch(`${at}/claims/${encodeURIComponent(claimed.claim.claimId)}`,
      { method: "DELETE", headers: auth });
    assert.equal(released.status, 200, await released.clone().text());
    const owing = await json(await worker.fetch(`${at}/awareness`, { headers: auth }));
    assert.equal(owing.blocks.find((entry) => entry.blockId === "status").owed.reason, "released");
    assert.equal(owing.blocks.find((entry) => entry.blockId === "relay").owed, null);
    // A page in the Web asks for the sections alone: the same changes and owed updates, nothing it reads live.
    const sections = await json(await worker.fetch(`${at}/awareness?scope=sections`, { headers: auth }));
    assert.deepEqual(sections.blocks.map(({ blockId, updated, owed }) => ({ blockId, revision: updated?.revision, owed: owed?.reason })),
      owing.blocks.filter((entry) => entry.updated || entry.owed).map(({ blockId, updated, owed }) =>
        ({ blockId, revision: updated?.revision, owed: owed?.reason })));
    assert.ok(sections.blocks.every((entry) => entry.claims.length === 0 && entry.present.length === 0
      && entry.discussions.length === 0 && entry.working.length === 0));
    await edit(third, (body) => body.replace("Shipped", "Shipped and verified"));
    const written = await json(await worker.fetch(`${at}/awareness`, { headers: auth }));
    assert.equal(written.blocks.find((entry) => entry.blockId === "status").owed, null, "writing it back settles it");
    const settle = await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/page-writeback`,
      { method: "POST", headers: auth, body: "{}" });
    assert.equal(settle.status, 200, await settle.clone().text());
    assert.deepEqual(await settle.json(), { settled: 0 });

    const stranger = await worker.fetch(`/api/spaces/${randomUUID()}/pages/${page.pageId}/awareness`, { headers: auth });
    assert.notEqual(stranger.status, 200, "awareness is read as the page is");
    const strangerSections = await worker.fetch(`/api/spaces/${randomUUID()}/pages/${page.pageId}/awareness?scope=sections`,
      { headers: auth });
    assert.notEqual(strangerSections.status, 200, "so are its sections alone");

    // The app reads a page straight from the Hub, from its own origin only, and only reads.
    const app = "https://xmatrix.test";
    const preflight = (origin, method = "GET") => worker.fetch(`${at}/awareness?scope=sections`, { method: "OPTIONS",
      headers: { origin, "access-control-request-method": method, "access-control-request-headers": "authorization" } });
    const allowed = await preflight(app);
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), app);
    assert.match(allowed.headers.get("access-control-allow-headers") ?? "", /authorization/u);
    assert.equal(allowed.headers.get("access-control-allow-credentials"), null, "a bearer, never a cookie");
    assert.equal((await preflight("https://elsewhere.test")).headers.get("access-control-allow-origin"), null);
    assert.equal((await preflight(app, "PUT")).headers.get("access-control-allow-origin"), null, "writes go through the Web");
    const direct = await worker.fetch(`${at}/awareness?scope=sections`, { headers: { ...auth, origin: app } });
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get("access-control-allow-origin"), app);
    assert.deepEqual(await direct.json(), await json(await worker.fetch(`${at}/awareness?scope=sections`, { headers: auth })),
      "the same answer as without an origin");
    const history = await worker.fetch(`/api/channels/${encodeURIComponent(channel.id)}/history?limit=10`, {
      method: "OPTIONS", headers: { origin: app, "access-control-request-method": "GET" } });
    assert.equal(history.headers.get("access-control-allow-origin"), app, "and a conversation's history");
    const write = await worker.fetch(at, { method: "PUT", headers: { ...auth, origin: app },
      body: JSON.stringify({ baseRevision: 0, body: "" }) });
    assert.equal(write.headers.get("access-control-allow-origin"), null);
  } finally {
    await worker.stop();
  }
});
