import assert from "node:assert/strict";
import test from "node:test";
import {
  inTestTransaction, MOCK_TOKEN, randomUUID, startPgHubWorker,
} from "./agent-launch-postgres.fixture.mjs";

import { withPageAgentRun } from "./support/page-agent.mjs";

// A page's schedules (docs/design/pages-live-document.md §6.1): a schedule is
// a line of its page, synced to its Automation after each revision as whoever
// wrote it; access follows the page, and a change to what it does by someone
// other than its author makes it theirs.

const AUDIT = "- [ ] Audit duplication and propose one cleanup 🔁 every 12 hours";
const GOALS = `# Goals\n\n## Architecture\n\nNo bloat.\n\n${AUDIT}\n\n## UI\n\nConsistent.\n`;

async function ok(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

/** The page's Automations once the revision just committed has synced them. */
async function synced(list, until) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const automations = await list();
    if (until(automations)) return automations;
    assert.ok(Date.now() < deadline, `the schedule did not sync: ${JSON.stringify(automations)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a page's schedule is its line, synced as whoever wrote it and managed by whoever can edit the page", async () => {
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
    // A new page's schedule lines are its Automations from its first revision.
    const page = (await ok(await call(ownerToken, pages, "POST", { title: "Goals", body: GOALS }))).page;
    const automations = `${pages}/${encodeURIComponent(page.pageId)}/automations`;
    const list = async () => (await ok(await call(ownerToken, automations))).automations;
    const read = async () => (await ok(await call(ownerToken, `${pages}/${page.pageId}`))).page;
    const edit = async (token, change) => {
      const current = await read();
      return ok(await call(token, `${pages}/${page.pageId}`, "PUT", { baseRevision: current.headRevision,
        body: change(current.body) }));
    };

    const [created] = await list();
    assert.equal(created.pageId, page.pageId);
    assert.equal(created.spaceId, space.id);
    assert.equal(created.enabled, true);
    assert.equal(created.intervalMinutes, 720);
    assert.equal(created.authorityRootUserId, ownerUserId, "it runs as whoever wrote its line");
    assert.equal(created.blockId, "architecture", "its section is where its line is");
    assert.equal(created.source, AUDIT);
    assert.equal(created.lastChannelId, undefined, "before it runs it opens no conversation");

    // The Space-wide list shows it with its page.
    const listed = (await ok(await call(memberToken, `/api/automations?spaceId=${space.id}`))).automations;
    assert.equal(listed.find((item) => item.id === created.id)?.pageId, page.pageId);

    // Its timing is its line: changing it changes the same Automation, as the same author.
    await edit(ownerToken, (body) => body.replace("every 12 hours", "every 6 hours"));
    let [current] = await synced(list, ([item]) => item?.intervalMinutes === 360);
    assert.equal(current.id, created.id);

    // `[-]` pauses it, also for someone else, who leaves its author as it was.
    await edit(memberToken, (body) => body.replace("- [ ] Audit", "- [-] Audit"));
    [current] = await synced(list, ([item]) => item?.enabled === false);
    assert.equal(current.id, created.id, "pausing keeps its author");
    assert.equal(current.capabilities.run, false);
    assert.equal((await call(memberToken, `${automations}/${created.id}/run`, "POST")).status, 409,
      "a paused schedule is resumed, not run");
    // Resuming it here changes its line back.
    await ok(await call(memberToken, `${automations}/${created.id}/resume`, "POST"));
    [current] = await synced(list, ([item]) => item?.enabled === true);
    assert.match((await read()).body, /- \[ \] Audit duplication/u);

    // Running it now makes its next occurrence due at once, as its author, and keeps its cadence.
    const before = Date.now();
    const ran = (await ok(await call(memberToken, `${automations}/${created.id}/run`, "POST"))).automation;
    assert.equal(ran.id, created.id, "running it keeps its author");
    assert.equal(ran.intervalMinutes, 360);
    assert.ok(Date.parse(ran.nextRunAt) <= Date.now() && Date.parse(ran.nextRunAt) >= before - 1_000, "due now");

    // A member's change to what it does makes it theirs.
    await edit(memberToken, (body) => body.replace("propose one cleanup", "propose one cleanup on every merge"));
    [current] = await synced(list, ([item]) => item && item.id !== created.id);
    assert.equal(current.authorityRootUserId, memberUserId);
    assert.equal(current.enabled, true);
    assert.equal(current.channelId, created.channelId, "it keeps being timed by the same conversation");

    // What it does is changed in its line only.
    const patched = await call(memberToken, `/api/automations/${current.id}`, "PATCH",
      { expectedVersion: current.version, intervalMinutes: 60 });
    assert.equal(patched.status, 409);
    assert.equal((await patched.json()).code, "schedule_lives_in_its_line");

    // A line that cannot run says why, to whoever wrote it and on the Automation.
    const written = await edit(ownerToken, (body) => `${body}\n- [ ] Sweep 🔁 every 3 months\n`);
    assert.deepEqual(written.scheduleProblems.map((line) => line.source), ["- [ ] Sweep 🔁 every 3 months"]);
    await edit(ownerToken, (body) => body.replace("- [ ] Sweep 🔁 every 3 months",
      "- [ ] Review merges 🔁 every day, on merged:acme/api@main"));
    const review = (await synced(list, (items) => items.some((item) => item.source?.includes("Review merges"))))
      .find((item) => item.source?.includes("Review merges"));
    assert.equal(review.enabled, false);
    assert.match(review.problem, /Connect GitHub/u);

    // A restricted page's schedules are read through that page only.
    const secret = (await ok(await call(ownerToken, pages, "POST", { title: "Private", accessMode: "restricted",
      body: "# Private\n\n## Plans\n\n- [ ] Sweep 🔁 every hour\n" }))).page;
    const [hidden] = (await ok(await call(ownerToken, `${pages}/${secret.pageId}/automations`))).automations;
    const memberCatalog = (await ok(await call(memberToken, `/api/automations?spaceId=${space.id}`))).automations;
    assert.equal(memberCatalog.some((item) => item.id === hidden.id), false);
    assert.equal(memberCatalog.some((item) => item.id === current.id), true);
    assert.equal((await call(memberToken, `${pages}/${secret.pageId}/automations`)).status, 404);
    assert.equal((await call(memberToken, `/api/automations/${hidden.id}`)).status, 404);

    // Deleting it takes its line out of the page.
    await ok(await call(ownerToken, `${automations}/${current.id}`, "DELETE"));
    assert.equal((await read()).body.includes("Audit duplication"), false);
    await synced(list, (items) => !items.some((item) => item.id === current.id));

    // Removing the page takes its Automations with it.
    await ok(await call(ownerToken, `${pages}/${page.pageId}`, "DELETE"));
    const rows = await inTestTransaction((tx) => tx.query({ text: "SELECT 1 FROM data.automations WHERE page_id=$1",
      values: [page.pageId] }));
    assert.equal(rows.length, 0);
  } finally {
    await worker.stop();
  }
});

test("an Agent Run writes a private page's schedules from its own authorized conversation, as its owner", async () => {
  const userId = `page-automation-agent-${randomUUID()}`;
  await withPageAgentRun({ id: userId, email: "page-automation-agent@example.com", name: "Agent Owner" },
    { slug: "page-automation", displayName: "auditor", mention: "@codex set up the audit" },
    async ({ worker, auth, asRun, pages, channel }) => {
    const page = (await ok(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title: "Goals", body: "# Goals\n\n## Architecture\n\nNo bloat.\n", accessMode: "restricted" }) })))
      .page;
    const automations = `${pages}/${encodeURIComponent(page.pageId)}/automations`;
    const list = async () => (await ok(await worker.fetch(automations, { headers: asRun }))).automations;
    const write = async (change) => {
      const head = (await ok(await worker.fetch(`${pages}/${page.pageId}`, { headers: asRun }))).page;
      return ok(await worker.fetch(`${pages}/${page.pageId}`, { method: "PUT", headers: asRun,
        body: JSON.stringify({ baseRevision: head.headRevision, body: change(head.body), conversationIds: [channel.id] }) }));
    };

    await write((body) => `${body}\n${AUDIT}\n`);
    const [created] = await synced(list, (items) => items.length === 1);
    assert.equal(created.authorityRootUserId, userId, "it runs as the Agent's owner, after the Run is gone too");
    assert.equal(created.enabled, true);
    assert.equal(created.blockId, "architecture");
    assert.notEqual(created.channelId, channel.id, "a conversation of its own times it");
    const revisions = (await ok(await worker.fetch(`${pages}/${page.pageId}/history`, { headers: auth }))).revisions;
    assert.equal(revisions[0].authors[0].kind, "agent", "the line is the Agent's edit");
    assert.deepEqual(revisions[0].conversationIds, [channel.id], "the edit belongs to the Run doing the work");
    const hiddenConversation = await worker.fetch(`/api/channels/${created.channelId}/history`, { headers: asRun });
    assert.equal(hiddenConversation.status, 404, "writing a schedule never grants the Agent its timer conversation");

    const ran = (await ok(await worker.fetch(`${automations}/${created.id}/run`, { method: "POST",
      headers: asRun, body: "{}" }))).automation;
    assert.equal(ran.id, created.id, "an Agent runs it now as the author it works for");
    await ok(await worker.fetch(`${automations}/${created.id}/pause`, { method: "POST", headers: asRun, body: "{}" }));
    const [paused] = await synced(list, ([item]) => item?.enabled === false);
    assert.equal(paused.id, created.id, "the Agent acts as the author it works for");

    // On a page that takes an Agent's edits as suggestions, its change to a line changes nothing until accepted.
    await ok(await worker.fetch(`${pages}/${page.pageId}`, { method: "PATCH", headers: auth,
      body: JSON.stringify({ agentSuggestOnly: true }) }));
    const suggested = await write((body) => body.replace("- [-] Audit", "- [ ] Audit"));
    assert.equal(suggested.kind, "suggestion");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await list())[0].enabled, false);
    await ok(await worker.fetch(`${pages}/${page.pageId}`, { method: "PATCH", headers: auth,
      body: JSON.stringify({ agentSuggestOnly: false }) }));

    // A Run cannot use the owner's membership in another Space.
    const elsewhere = (await ok(await worker.fetch("/api/spaces", { method: "POST", headers: auth,
      body: JSON.stringify({ name: "Elsewhere" }) }))).space;
    const wrongSpace = await worker.fetch(`/api/spaces/${elsewhere.id}/pages/${page.pageId}/automations/${created.id}/run`,
      { method: "POST", headers: asRun, body: "{}" });
    assert.equal(wrongSpace.status, 403);
    assert.equal((await wrongSpace.json()).code, "agent_run_forbidden");

    // Read access is not enough to change a schedule.
    const spaceId = decodeURIComponent(pages.split("/")[3]);
    await inTestTransaction(async (tx) => {
      await tx.query({ text: "UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id=$2",
        values: [spaceId, userId] });
      await tx.query({ text: `INSERT INTO data.page_access (space_id,page_id,subject_kind,subject_id,access,created_at)
        VALUES ($1,$2,'user',$3,'read',now()) ON CONFLICT (space_id,page_id,subject_kind,subject_id) DO UPDATE SET access='read'`,
        values: [spaceId, page.pageId, userId] });
    });
    const readOnly = await worker.fetch(`${automations}/${created.id}`, { method: "DELETE", headers: asRun });
    assert.equal(readOnly.status, 403);
    assert.equal((await readOnly.json()).code, "page_edit_forbidden");
    const persisted = await inTestTransaction(tx => tx.query({ text: `SELECT enabled FROM data.automations
      WHERE page_id=$1 AND automation_id=$2`, values: [page.pageId, created.id] }));
    assert.deepEqual(persisted.map(row => row.enabled), [false], "a refused change never removes or changes it");
  });
});

test("a reminder is a ⏳ line: it runs once at the time written with its offset, and a new time arms it again", async () => {
  const unique = randomUUID();
  const ownerToken = `page-reminder-owner-${unique}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
    XMATRIX_MOCK_AUTH_USERS: JSON.stringify({
      [ownerToken]: { id: `page-reminder-user-${unique}`, email: `reminder-${unique}@example.com`, name: "Traveller" },
    }),
  } });
  const call = (path, method = "GET", body) => worker.fetch(path, { method,
    headers: { Authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const space = (await ok(await call("/api/spaces", "POST", { name: `Trip ${unique}` }))).space;
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    // 18:00 in Bali (UTC+8), two days ahead, written as the traveller would.
    const local = new Date(Date.now() + 2 * 86_400_000 + 8 * 3_600_000).toISOString();
    const at = `${local.slice(0, 10)} ${local.slice(11, 16)} +08:00`;
    const line = `- [ ] Decide whether to extend at Allende Canggu ⏳ ${at}`;
    const page = (await ok(await call(pages, "POST", { title: "Bali",
      body: `# Bali\n\n## Stays\n\nAllende Canggu until 10/30.\n\n${line}\n` }))).page;
    const automations = `${pages}/${encodeURIComponent(page.pageId)}/automations`;
    const list = async () => (await ok(await call(automations))).automations;
    const edit = async (change) => {
      const current = (await ok(await call(`${pages}/${page.pageId}`))).page;
      return ok(await call(`${pages}/${page.pageId}`, "PUT", { baseRevision: current.headRevision,
        body: change(current.body) }));
    };

    const [reminder] = await list();
    assert.equal(reminder.once, true);
    assert.equal(reminder.enabled, true);
    assert.equal(reminder.nextRunAt, new Date(Date.parse(`${local.slice(0, 16)}+08:00`)).toISOString(),
      "it runs at the time written, read with its offset");
    assert.equal(reminder.blockId, "stays");

    // A time without its offset is not read as UTC; it says what is missing.
    const unzoned = await edit((body) => body.replace(` ${at}`, ` ${at.slice(0, 16)}`));
    assert.match(unzoned.scheduleProblems[0].problem, /offset/u);
    await edit((body) => body.replace(` ${at.slice(0, 16)}\n`, ` ${at}\n`));
    await synced(list, ([item]) => item?.enabled === true && !item.problem);

    // Delivered, it stops at the time it ran (as finishMessage leaves it) and its line is checked off;
    // a new time and `[ ]` arm it again.
    await inTestTransaction(tx => tx.query({ text: `UPDATE data.automations SET enabled=false,
      next_run_at=now()-interval '1 minute',last_run_at=now(),version=version+1 WHERE page_id=$1`,
    values: [page.pageId] }));
    await edit((body) => body.replace("- [ ] Decide", "- [x] Decide").replace(` ${at}`, ` ${at} ✅ 2026-11-01`));
    const later = new Date(Date.now() + 20 * 86_400_000).toISOString();
    await edit((body) => body.replace(/- \[x\] Decide(.*)⏳ .*$/mu, `- [ ] Decide$1⏳ ${later.slice(0, 10)} ${
      later.slice(11, 16)} Z`));
    const [armed] = await synced(list, ([item]) => item?.enabled === true);
    assert.equal(armed.once, true);
    assert.equal(armed.nextRunAt, `${later.slice(0, 16)}:00.000Z`);
  } finally {
    await worker.stop();
  }
});
