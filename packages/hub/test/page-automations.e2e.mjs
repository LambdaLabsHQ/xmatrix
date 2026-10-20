import assert from "node:assert/strict";
import test from "node:test";
import {
  inTestTransaction, MOCK_TOKEN, randomUUID, startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";

import { withPageAgentRun } from "./support/page-agent.mjs";

// A page's Automations (docs/design/pages-live-document.md §6): the reference
// in the page's text is the anchor, access follows the page, and an edit by
// someone other than the author replaces the Automation with their own.

const GOALS = "# Goals\n\n## Architecture\n\nNo bloat.\n\n## UI\n\nConsistent.\n";
const reference = (id) => `](xmatrix:automation/${id})`;

async function ok(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("a page's Automation is anchored by its reference and managed by whoever can edit the page", async () => {
  const unique = randomUUID();
  const ownerToken = `page-automation-owner-${unique}`;
  const memberToken = `page-automation-member-${unique}`;
  const ownerUserId = `page-automation-owner-user-${unique}`;
  const memberUserId = `page-automation-member-user-${unique}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
      [ownerToken]: { id: ownerUserId, email: `owner-${unique}@example.com`, name: "Page Owner" },
      [memberToken]: { id: memberUserId, email: `member-${unique}@example.com`, name: "Page Member" },
    }),
  } });
  const headers = (token) => ({ Authorization: `Bearer ${token}`, "content-type": "application/json" });
  const call = (token, path, method = "GET", body) => worker.fetch(path, { method, headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const space = (await ok(await call(ownerToken, "/api/spaces", "POST", { name: `Pages ${unique}` }))).space;
    const invite = (await ok(await call(ownerToken, `/api/spaces/${space.id}/invites`, "POST", { role: "member" }))).invite;
    await ok(await call(memberToken, `/api/space-invites/${encodeURIComponent(invite.token)}/accept`, "POST"));
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const page = (await ok(await call(ownerToken, pages, "POST", { title: "Goals", body: GOALS }))).page;
    const automations = `${pages}/${encodeURIComponent(page.pageId)}/automations`;
    const readBody = async () => (await ok(await call(ownerToken, `${pages}/${page.pageId}`))).page;

    const created = (await ok(await call(ownerToken, automations, "POST", { name: "Code audit",
      instruction: "Audit duplication and propose one cleanup", intervalMinutes: 720, blockId: "architecture" }), 201))
      .automation;
    assert.equal(created.pageId, page.pageId);
    assert.equal(created.spaceId, space.id);
    assert.equal(created.enabled, true, "its reference on the page attached it");
    assert.equal(created.detachedAt, undefined);
    assert.equal(created.authorityRootUserId, ownerUserId);
    assert.equal(created.blockId, "architecture", "its section is where its reference is");
    let current = await readBody();
    assert.match(current.body, /## Architecture\n\nNo bloat\.\n\n\[Code audit\]\(xmatrix:automation\//u);
    assert.ok(current.body.indexOf(reference(created.id)) < current.body.indexOf("## UI"), "it sits in its section");
    const links = (await ok(await call(ownerToken, `/api/spaces/${space.id}/page-links?conversationId=${created.channelId}`))).links;
    assert.deepEqual(links.map((link) => [link.pageId, link.blockId]), [[page.pageId, "architecture"]],
      "its conversation is linked to the section it serves");

    // The Space-wide list shows it with its page.
    const listed = (await ok(await call(memberToken, `/api/automations?spaceId=${space.id}`))).automations;
    assert.equal(listed.find((item) => item.id === created.id)?.pageId, page.pageId);

    // Deleting the reference pauses it; only putting the reference back resumes it.
    await ok(await call(ownerToken, `${pages}/${page.pageId}`, "PUT", { baseRevision: current.headRevision,
      body: GOALS }));
    let [detached] = (await ok(await call(ownerToken, automations))).automations;
    assert.equal(detached.enabled, false);
    assert.ok(detached.detachedAt);
    assert.equal(detached.capabilities.resume, false);
    assert.equal(detached.blockId, undefined);
    const resumed = await call(ownerToken, `${automations}/${created.id}/resume`, "POST",
      { expectedVersion: detached.version });
    assert.equal(resumed.status, 409);
    assert.equal((await resumed.json()).code, "automation_detached");
    const back = (await ok(await call(ownerToken, `${automations}/${created.id}/reference`, "POST",
      { blockId: "ui" }))).automation;
    assert.equal(back.enabled, true);
    assert.equal(back.detachedAt, undefined);
    assert.equal(back.blockId, "ui");
    current = await readBody();
    assert.ok(current.body.indexOf(reference(created.id)) > current.body.indexOf("## UI"), "put back in UI");

    // Pausing keeps it paused through edits that keep its reference.
    const paused = (await ok(await call(memberToken, `${automations}/${created.id}/pause`, "POST",
      { expectedVersion: back.version }))).automation;
    assert.equal(paused.enabled, false);
    assert.equal(paused.detachedAt, undefined);
    assert.equal(paused.id, created.id, "pausing keeps its author");
    assert.equal(paused.capabilities.run, false);
    const runPaused = await call(memberToken, `${automations}/${created.id}/run`, "POST",
      { expectedVersion: paused.version });
    assert.equal(runPaused.status, 409, "a paused Automation is resumed, not run");
    const running = (await ok(await call(ownerToken, `${automations}/${created.id}/resume`, "POST",
      { expectedVersion: paused.version }))).automation;
    assert.equal(running.enabled, true);

    // Running it now makes its next occurrence due at once, as its author, and keeps its cadence.
    const before = Date.now();
    const resumedByOwner = (await ok(await call(memberToken, `${automations}/${created.id}/run`, "POST",
      { expectedVersion: running.version }))).automation;
    assert.equal(resumedByOwner.id, created.id, "running it keeps its author");
    assert.equal(resumedByOwner.intervalMinutes, running.intervalMinutes);
    assert.ok(Date.parse(resumedByOwner.nextRunAt) <= Date.now() &&
      Date.parse(resumedByOwner.nextRunAt) >= before - 1_000, "due now");

    // A member's edit replaces it with their own, and the page points at the replacement.
    const replaced = (await ok(await call(memberToken, `${automations}/${created.id}`, "PATCH", {
      expectedVersion: resumedByOwner.version, instruction: "Audit duplication on every merge",
    }))).automation;
    assert.notEqual(replaced.id, created.id);
    assert.equal(replaced.authorityRootUserId, memberUserId);
    assert.equal(replaced.enabled, true);
    assert.equal(replaced.channelId, created.channelId, "it keeps working in the same conversation");
    current = await readBody();
    assert.ok(current.body.includes(reference(replaced.id)));
    assert.ok(!current.body.includes(reference(created.id)));
    assert.deepEqual((await ok(await call(ownerToken, automations))).automations.map((item) => item.id), [replaced.id]);

    // Through the Space-wide route too, a page's Automation changes through its page.
    const retimed = await ok(await call(memberToken, `/api/automations/${replaced.id}`, "PATCH",
      { expectedVersion: replaced.version, intervalMinutes: 60 }));
    assert.equal(retimed.automation.intervalMinutes, 60);
    assert.equal(retimed.automation.id, replaced.id, "its author edits it in place");

    // An edit can say when the next occurrence is; a time already past is refused.
    const nextRunAt = new Date(Date.now() + 7 * 3_600_000).toISOString();
    const staggered = (await ok(await call(memberToken, `${automations}/${replaced.id}`, "PATCH",
      { expectedVersion: retimed.automation.version, nextRunAt }))).automation;
    assert.equal(staggered.nextRunAt, nextRunAt);
    assert.equal(staggered.intervalMinutes, 60, "its cadence is unchanged");
    const past = await call(memberToken, `${automations}/${replaced.id}`, "PATCH",
      { expectedVersion: staggered.version, nextRunAt: new Date(Date.now() - 1_000).toISOString() });
    assert.equal(past.status, 400);
    assert.equal((await past.json()).code, "invalid_next_run");

    // A restricted page's Automations are read through that page only.
    const secret = (await ok(await call(ownerToken, pages, "POST", { title: "Private", accessMode: "restricted",
      body: "# Private\n\n## Plans\n" }))).page;
    const hidden = (await ok(await call(ownerToken, `${pages}/${secret.pageId}/automations`, "POST", {
      name: "Private sweep", instruction: "Sweep", intervalMinutes: 60, blockId: "plans" }), 201)).automation;
    const memberCatalog = (await ok(await call(memberToken, `/api/automations?spaceId=${space.id}`))).automations;
    assert.equal(memberCatalog.some((item) => item.id === hidden.id), false);
    assert.equal(memberCatalog.some((item) => item.id === replaced.id), true);
    assert.equal((await call(memberToken, `${pages}/${secret.pageId}/automations`)).status, 404);
    assert.equal((await call(memberToken, `/api/automations/${hidden.id}`)).status, 404);

    // Deleting it takes its reference out of the page.
    await ok(await call(ownerToken, `${automations}/${replaced.id}?expectedVersion=${staggered.version}`,
      "DELETE"));
    current = await readBody();
    assert.equal(current.body.includes("xmatrix:automation/"), false);
    assert.deepEqual((await ok(await call(ownerToken, automations))).automations, []);

    // Removing the page takes its Automations with it.
    const second = (await ok(await call(ownerToken, automations, "POST", { name: "UI sweep",
      instruction: "Sweep the UI", intervalMinutes: 1440, blockId: "ui" }), 201)).automation;
    await ok(await call(ownerToken, `${pages}/${page.pageId}`, "DELETE"));
    const rows = await inTestTransaction((tx) => tx.query({ text: "SELECT 1 FROM data.automations WHERE automation_id=$1",
      values: [second.id] }));
    assert.equal(rows.length, 0);
  } finally {
    await worker.stop();
  }
});

test("an Agent Run manages a private page's Automations from its own authorized conversation", async () => {
  const userId = `page-automation-agent-${randomUUID()}`;
  await withPageAgentRun({ id: userId, email: "page-automation-agent@example.com", name: "Agent Owner" },
    { slug: "page-automation", displayName: "auditor", mention: "@codex set up the audit" },
    async ({ worker, auth, asRun, pages, channel }) => {
    const page = (await ok(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title: "Goals", body: GOALS, accessMode: "restricted" }) }))).page;
    const automations = `${pages}/${encodeURIComponent(page.pageId)}/automations`;

    const created = (await ok(await worker.fetch(automations, { method: "POST", headers: asRun, body: JSON.stringify({
      name: "Code audit", instruction: "Audit duplication", intervalMinutes: 720, blockId: "architecture" }) }), 201))
      .automation;
    assert.equal(created.authorityRootUserId, userId, "it runs as the Agent's owner, after the Run is gone too");
    assert.equal(created.enabled, true);
    assert.notEqual(created.channelId, channel.id, "it works in a conversation of its own");
    const revisions = (await ok(await worker.fetch(`${pages}/${page.pageId}/history`, { headers: auth }))).revisions;
    assert.equal(revisions[0].authors[0].kind, "agent", "the reference is the Agent's edit");
    assert.deepEqual(revisions[0].conversationIds, [channel.id], "the edit belongs to the Run doing the work");
    await ok(await worker.fetch(`/api/channels/${created.channelId}/history`, { headers: auth }));
    const hiddenConversation = await worker.fetch(`/api/channels/${created.channelId}/history`, { headers: asRun });
    assert.equal(hiddenConversation.status, 404, "authoring never grants the Agent access to the private timer conversation");

    const listed = (await ok(await worker.fetch(automations, { headers: asRun }))).automations;
    assert.deepEqual(listed.map((item) => [item.id, item.capabilities.update]), [[created.id, true]]);
    const ran = (await ok(await worker.fetch(`${automations}/${created.id}/run`, { method: "POST",
      headers: asRun, body: JSON.stringify({ expectedVersion: created.version }) }))).automation;
    assert.equal(ran.id, created.id, "an Agent runs it now as the author it works for");
    const paused = (await ok(await worker.fetch(`${automations}/${created.id}/pause`, { method: "POST",
      headers: asRun, body: JSON.stringify({ expectedVersion: ran.version }) }))).automation;
    assert.equal(paused.enabled, false);
    assert.equal(paused.id, created.id, "the Agent acts as the author it works for");

    await ok(await worker.fetch(`${pages}/${page.pageId}`, { method: "PATCH", headers: auth,
      body: JSON.stringify({ agentSuggestOnly: true }) }));
    const refused = await worker.fetch(`${automations}/${created.id}/resume`, { method: "POST", headers: asRun,
      body: JSON.stringify({ expectedVersion: paused.version }) });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).code, "page_automation_needs_person");
    await ok(await worker.fetch(`${pages}/${page.pageId}`, { method: "PATCH", headers: auth,
      body: JSON.stringify({ agentSuggestOnly: false }) }));

    // A Run cannot use the owner's membership in another Space.
    const elsewhere = (await ok(await worker.fetch("/api/spaces", { method: "POST", headers: auth,
      body: JSON.stringify({ name: "Elsewhere" }) }))).space;
    const wrongSpace = await worker.fetch(`/api/spaces/${elsewhere.id}/pages/${page.pageId}/automations`, {
      method: "POST", headers: asRun, body: JSON.stringify({ name: "Wrong Space", instruction: "Sweep", intervalMinutes: 60 }) });
    assert.equal(wrongSpace.status, 403);
    assert.equal((await wrongSpace.json()).code, "agent_run_forbidden");

    // Arrange an ordinary member's explicit edit grant, then revoke it after
    // the live page session has already accepted an edit from this Run.
    const spaceId = decodeURIComponent(pages.split("/")[3]);
    await inTestTransaction(async (tx) => {
      await tx.query({ text: "UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id=$2",
        values: [spaceId, userId] });
      await tx.query({ text: `INSERT INTO data.page_access (space_id,page_id,subject_kind,subject_id,access,created_at)
        VALUES ($1,$2,'user',$3,'edit',now()) ON CONFLICT (space_id,page_id,subject_kind,subject_id) DO UPDATE SET access='edit'`,
        values: [spaceId, page.pageId, userId] });
    });
    const head = (await ok(await worker.fetch(`${pages}/${page.pageId}`, { headers: asRun }))).page;
    await ok(await worker.fetch(`${pages}/${page.pageId}`, { method: "PUT", headers: asRun,
      body: JSON.stringify({ baseRevision: head.headRevision, body: GOALS, conversationIds: [channel.id] }) }));
    const attached = (await ok(await worker.fetch(`${automations}/${created.id}/reference`, { method: "POST",
      headers: asRun, body: JSON.stringify({ blockId: "ui" }) }))).automation;
    assert.equal(attached.detachedAt, undefined, "an authorized member's Agent reattaches through its own conversation");
    assert.equal(attached.blockId, "ui");
    await inTestTransaction(tx => tx.query({ text: "UPDATE data.page_access SET access='read' WHERE space_id=$1 AND page_id=$2",
      values: [spaceId, page.pageId] }));
    const readOnly = await worker.fetch(`${automations}/${created.id}?expectedVersion=${attached.version}`, {
      method: "DELETE", headers: asRun });
    assert.equal(readOnly.status, 403);
    assert.equal((await readOnly.json()).code, "page_edit_forbidden");
    await inTestTransaction(tx => tx.query({ text: "DELETE FROM data.page_access WHERE space_id=$1 AND page_id=$2",
      values: [spaceId, page.pageId] }));
    const revoked = await worker.fetch(`${automations}/${created.id}/reference`, { method: "POST", headers: asRun,
      body: JSON.stringify({ blockId: "architecture" }) });
    assert.equal(revoked.status, 404);
    assert.equal((await revoked.json()).code, "page_not_found");
    const persisted = await inTestTransaction(tx => tx.query({ text: `SELECT version,enabled FROM data.automations
      WHERE page_id=$1 AND automation_id=$2`, values: [page.pageId, created.id] }));
    assert.deepEqual(persisted.map(row => [Number(row.version), row.enabled]), [[attached.version, attached.enabled]],
      "refused writes never remove or change the Automation");
    await inTestTransaction(tx => tx.query({ text: `INSERT INTO data.page_access
      (space_id,page_id,subject_kind,subject_id,access,created_at) VALUES ($1,$2,'user',$3,'edit',now())`,
      values: [spaceId, page.pageId, userId] }));
    await ok(await worker.fetch(`${automations}/${created.id}?expectedVersion=${attached.version}`, {
      method: "DELETE", headers: asRun }));
    const cleaned = (await ok(await worker.fetch(`${pages}/${page.pageId}`, { headers: asRun }))).page;
    assert.equal(cleaned.body.includes(reference(created.id)), false, "deletion removes the private page's reference");
  });
});
