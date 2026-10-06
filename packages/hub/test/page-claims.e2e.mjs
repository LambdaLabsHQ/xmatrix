import assert from "node:assert/strict";
import test from "node:test";
import {
  json, randomUUID,
} from "./agent-launch-postgres.fixture.mjs";

import { withPageAgentRun } from "./support/page-agent.mjs";

// Claims end to end: a launched Agent Run claims a block as itself, the block
// is busy for others until an owner opens it for competition, and the Run
// releases its claim when done.
test("a launched Agent Run claims a block, holds it against others and releases it", async () => {
  const userId = `page-claims-${randomUUID()}`;
  await withPageAgentRun({ id: userId, email: "page-claims@example.com", name: "Page Claims" },
    { slug: "claims", displayName: "claimer", mention: "@codex take the search section" },
    async ({ worker, auth, asRun, pages, channel }) => {
    const page = (await json(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title: "Roadmap", body: "# Roadmap\n\n## Search\n\nNext.\n" }) }))).page;
    const claims = `${pages}/${encodeURIComponent(page.pageId)}/claims`;
    const claim = (headers, body) => worker.fetch(claims, { method: "POST", headers, body: JSON.stringify(body) });

    const taken = await claim(asRun, { blockId: "search", minutes: 30 });
    assert.equal(taken.status, 200, await taken.clone().text());
    const held = (await taken.json()).claim;
    assert.equal(held.holder.kind, "agent");
    assert.equal(held.ownerUserId, userId, "the Agent's claim counts against its owner");
    assert.equal(held.conversationId, channel.id, "the claim points at the conversation doing the work");

    const busy = await claim(auth, { blockId: "search" });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, "page_block_claimed");
    const listed = await json(await worker.fetch(claims, { headers: auth }));
    assert.deepEqual(listed.claims.map((c) => c.claimId), [held.claimId]);
    assert.deepEqual(listed.competitiveBlocks, []);

    const opened = await worker.fetch(`${pages}/${encodeURIComponent(page.pageId)}/competition`, {
      method: "PUT", headers: auth, body: JSON.stringify({ blockId: "search", open: true }) });
    assert.equal(opened.status, 200, await opened.clone().text());
    assert.equal((await claim(auth, { blockId: "search" })).status, 200, "an open block takes a second claim");

    const released = await worker.fetch(`${claims}/${encodeURIComponent(held.claimId)}`, { method: "DELETE", headers: asRun });
    assert.deepEqual(await json(released), { released: true });
    assert.equal((await json(await worker.fetch(claims, { headers: asRun }))).claims.length, 1);
  });
});
