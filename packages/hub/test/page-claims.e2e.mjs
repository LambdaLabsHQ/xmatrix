import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import {
  json, randomUUID,
} from "./agent-launch-postgres.fixture.mjs";

import { withPageAgentRun } from "./support/page-agent.mjs";

/** A page with a Search section, and its claims route. */
async function roadmap(worker, pages, auth) {
  const page = (await json(await worker.fetch(pages, { method: "POST", headers: auth,
    body: JSON.stringify({ title: "Roadmap", body: "# Roadmap\n\n## Search\n\nNext.\n" }) }))).page;
  return { page, claims: `${pages}/${encodeURIComponent(page.pageId)}/claims` };
}

// Claims end to end: a launched Agent Run claims a block as itself; a claim
// locks nothing, so a second one on the block is taken too and is told who is
// already there; the Run releases its claim when done.
test("a launched Agent Run claims a block, a second claim is taken beside it, and the Run releases its own", async () => {
  const userId = `page-claims-${randomUUID()}`;
  await withPageAgentRun({ id: userId, email: "page-claims@example.com", name: "Page Claims" },
    { slug: "claims", displayName: "claimer", mention: "@codex take the search section" },
    async ({ worker, auth, asRun, pages, channel }) => {
    const { claims } = await roadmap(worker, pages, auth);
    const claim = (headers, body) => worker.fetch(claims, { method: "POST", headers, body: JSON.stringify(body) });

    const taken = await claim(asRun, { blockId: "search", minutes: 30 });
    assert.equal(taken.status, 200, await taken.clone().text());
    const held = (await taken.json()).claim;
    assert.equal(held.holder.kind, "agent");
    assert.equal(held.ownerUserId, userId, "the Agent's claim counts against its owner");
    assert.equal(held.conversationId, channel.id, "the claim points at the conversation doing the work");

    const beside = await claim(auth, { blockId: "search" });
    assert.equal(beside.status, 200, await beside.clone().text());
    const second = await beside.json();
    assert.deepEqual(second.others.map((c) => c.claimId), [held.claimId], "it is told who is already there");
    const listed = await json(await worker.fetch(claims, { headers: auth }));
    assert.deepEqual(listed.claims.map((c) => c.claimId).sort(), [held.claimId, second.claim.claimId].sort());

    const released = await worker.fetch(`${claims}/${encodeURIComponent(held.claimId)}`, { method: "DELETE", headers: asRun });
    assert.deepEqual(await json(released), { released: true });
    assert.equal((await json(await worker.fetch(claims, { headers: asRun }))).claims.length, 1);
  });
});

// An Automation occurrence holds its section for its conversation as the
// Automation's author; the Run launched there takes that same claim over.
test("a Run takes over the claim its Automation occurrence opened for its conversation", async () => {
  const userId = `page-claims-occurrence-${randomUUID()}`;
  await withPageAgentRun({ id: userId, email: "page-claims-occurrence@example.com", name: "Page Claims" },
    { slug: "claims-occurrence", displayName: "auditor", mention: "@codex audit the search section" },
    async ({ worker, auth, asRun, pages, channel }) => {
    const { page, claims } = await roadmap(worker, pages, auth);
    const spaceId = decodeURIComponent(/\/api\/spaces\/([^/]+)\//u.exec(pages)[1]);
    const occurrenceClaimId = randomUUID();
    const client = new Client({ connectionString: worker.postgresUrl });
    await client.connect();
    try {
      await client.query(`INSERT INTO data.page_claims (space_id,claim_id,page_id,block_id,holder_kind,holder_id,
          holder_label,owner_user_id,conversation_id,state,expires_at,created_at,updated_at)
        VALUES ($1,$2,$3,'search','user',$4,'Daily audit',$4,$5,'active',now() + interval '1 hour',now(),now())`,
        [spaceId, occurrenceClaimId, page.pageId, userId, channel.id]);
    } finally {
      await client.end();
    }
    const taken = await worker.fetch(claims, { method: "POST", headers: asRun,
      body: JSON.stringify({ blockId: "search", minutes: 30 }) });
    assert.equal(taken.status, 200, await taken.clone().text());
    const held = (await taken.json()).claim;
    assert.equal(held.claimId, occurrenceClaimId, "the same claim, not a second one");
    assert.equal(held.holder.kind, "agent");
    const listed = (await json(await worker.fetch(claims, { headers: auth }))).claims;
    assert.deepEqual(listed.map((claim) => [claim.claimId, claim.holder.kind]), [[occurrenceClaimId, "agent"]]);
  });
});
