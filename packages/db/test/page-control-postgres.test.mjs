import { postgresDatabase as database, connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "pg";

import { PostgresPageRepository, pagePositionBetween } from "../dist/page-control.js";
import { readPageConversations } from "../dist/page-conversations.js";



async function fixture(client, id) {
  const ids = {
    space: `${id}-space`, owner: `${id}-owner`, member: `${id}-member`, viewer: `${id}-viewer`,
    open: `${id}-open`, closed: `${id}-closed`, agent: `${id}-agent`,
  };
  ids.instance = `${ids.open}:1`;
  ids.run = `${ids.instance}#1`;
  await client.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
    VALUES ('shard-0','active','test',now(),now()) ON CONFLICT DO NOTHING`);
  await client.query(`INSERT INTO control.space_placement
    (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
    VALUES ($1,'shard-0',1,'active',NULL,'test',now(),now())`, [ids.space]);
  await client.query(`INSERT INTO data.spaces
    (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,'Pages test',$1,1,'{}',now(),now())`, [ids.space, ids.owner]);
  for (const [userId, role] of [[ids.owner, "owner"], [ids.member, "member"], [ids.viewer, "viewer"]]) {
    await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$2,$3,1,now(),now())`, [ids.space, userId, role]);
  }
  for (const [channelId, mode] of [[ids.open, "open"], [ids.closed, "closed"]]) {
    await client.query(`INSERT INTO data.channels
      (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
       metadata_json,created_at,updated_at)
      VALUES ($1,$2,$1,$1,$3,$1,1,'{}'::jsonb,now(),now())`, [channelId, ids.space, mode]);
    await client.query(`INSERT INTO control.channel_space_routes
      (channel_id,space_id,shard_id,placement_epoch,entity_version,state,updated_at)
      VALUES ($1,$2,'shard-0',1,1,'active',now())`, [channelId, ids.space]);
  }
  await client.query(`INSERT INTO data.channel_access
    (space_id,channel_id,subject_kind,subject_id,grant_version,created_at,updated_at)
    VALUES ($1,$2,'user',$3,1,now(),now())`, [ids.space, ids.closed, ids.owner]);
  await client.query(`INSERT INTO data.runs
    (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,$3,'running',1,'{"executionKey":"execution-1"}',now(),now())`,
  [ids.run, ids.member, ids.open]);
  await client.query(`INSERT INTO data.instances
    (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
    VALUES ($1,$2,$3,1,'online',1,now(),now())`, [ids.instance, ids.run, ids.open]);
  await client.query(`INSERT INTO control.entity_space_routes
    (entity_kind,entity_id,space_id,shard_id,placement_epoch,entity_version,route_version,state,updated_at)
    VALUES ('run',$1,$2,'shard-0',1,1,1,'active',now())`, [ids.run, ids.space]);
  // The Run executes under the member's Space Agent Registration.
  const key = [ids.space, ids.member, ids.machine = `${id}-machine`, "claude"];
  const limits = JSON.stringify({ workspaces: [], models: [], secrets: [], capabilities: [] });
  await client.query(`INSERT INTO data.agent_registrations (owner_user_id,machine_id,harness,version,created_at,updated_at)
    VALUES ($1,$2,$3,1,now(),now())`, key.slice(1));
  await client.query(`INSERT INTO data.space_agent_registrations
    (space_id,owner_user_id,machine_id,harness,display_name,configuration_json,version,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'claude','{}',1,now(),now())`, key);
  await client.query(`INSERT INTO data.space_agent_registration_access
    (space_id,owner_user_id,machine_id,harness,grant_state,grant_revision,grant_limits,
     policy_state,policy_revision,policy_limits,updated_at)
    VALUES ($1,$2,$3,$4,'active',1,$5::jsonb,'enabled',1,$5::jsonb,now())`, [...key, limits]);
  await client.query(`INSERT INTO data.run_agent_registrations
    (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
     grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
    VALUES ($1,$2,$3,$4,$5,$3,'allocation',repeat('a',64),1,1,1,1,$6::jsonb)`, [ids.run, ...key, limits]);
  return ids;
}

/** A second Instance in the open conversation, asleep under its own ended Run. */
async function addSleepingInstance(client, ids) {
  const instance = `${ids.open}:2`;
  const run = `${instance}#1`;
  await client.query(`INSERT INTO data.runs
    (run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
    VALUES ($1,$2,$3,'stopped',1,'{}',now() - interval '1 hour',now())`, [run, ids.member, ids.open]);
  await client.query(`INSERT INTO data.instances
    (instance_id,run_id,channel_id,channel_instance_id,status,rest_state,version,created_at,updated_at)
    VALUES ($1,$2,$3,2,'offline','sleeping',1,now() - interval '1 hour',now())`, [instance, run, ids.open]);
  await client.query(`INSERT INTO data.run_agent_registrations
    (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
     grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
    SELECT $1,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id || '-asleep',authorization_digest,
      grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json
    FROM data.run_agent_registrations WHERE run_id=$2`, [run, ids.run]);
}

async function cleanup(client, ids) {
  for (const table of ["page_reads", "page_claims", "page_block_competitions", "page_links", "page_access", "page_revisions", "pages"]) {
    await client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [ids.space]).catch(() => {});
  }
  await client.query("DELETE FROM control.entity_space_routes WHERE entity_id=$1", [ids.run]).catch(() => {});
  await client.query("DELETE FROM data.run_agent_registrations WHERE run_id=$1 OR run_id=$2",
    [ids.run, `${ids.open}:2#1`]).catch(() => {});
  for (const table of ["space_agent_registration_access", "space_agent_registrations"]) {
    await client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [ids.space]).catch(() => {});
  }
  await client.query("DELETE FROM data.agent_registrations WHERE machine_id=$1", [ids.machine]).catch(() => {});
  await client.query("DELETE FROM data.instances WHERE channel_id=$1", [ids.open]).catch(() => {});
  await client.query("DELETE FROM data.runs WHERE channel_id=$1", [ids.open]).catch(() => {});
  await client.query("DELETE FROM control.channel_space_routes WHERE space_id=$1", [ids.space]).catch(() => {});
  for (const table of ["channel_access", "channels", "space_members", "spaces"]) {
    await client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [ids.space]).catch(() => {});
  }
  await client.query("DELETE FROM control.space_placement WHERE space_id=$1", [ids.space]).catch(() => {});
}

async function pageTest(prefix) {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const ids = await fixture(client, `${prefix}-${crypto.randomUUID()}`);
    const pages = new PostgresPageRepository(database(client));
    return { client, ids, pages,
      owner: { kind: "user", id: ids.owner, label: "Owner" },
      member: { kind: "user", id: ids.member, label: "Member" },
      viewer: { kind: "user", id: ids.viewer, label: "Viewer" },
      agent: { kind: "agent", id: ids.instance, label: "claude:1",
        runProof: { runId: ids.run, instanceId: ids.instance, executionKey: "execution-1" } },
    };
  } catch (error) { await client.end(); throw error; }
}

const code = (expected) => (error) => {
  assert.equal(error.code, expected, error.message);
  return true;
};

test("sibling positions always sort strictly between their neighbours", () => {
  let before = null;
  const keys = [];
  for (let i = 0; i < 50; i++) {
    const key = pagePositionBetween(before, null);
    keys.push(key);
    before = key;
  }
  assert.deepEqual([...keys].sort(), keys);
  const middle = pagePositionBetween(keys[3], keys[4]);
  assert.ok(middle > keys[3] && middle < keys[4]);
  // A generated key never ends in the smallest digit, so there is always room before it.
  assert.ok(keys.every((key) => !key.endsWith("0")));
  assert.ok(pagePositionBetween(null, keys[0]) < keys[0]);
});

integration("pages: how far a person has read a page is theirs, only moves forward and goes with the page", async () => {
  const { client, ids, pages, owner, viewer, agent } = await pageTest("page-reads");
  try {
    const call = (method, input) => pages[method]({ spaceId: ids.space, ...input, requestId: crypto.randomUUID() });
    const { page } = await call("create", { principal: owner, title: "Plan", body: "# Plan\n" });
    for (const body of ["# Plan\n\nOne\n", "# Plan\n\nTwo\n"]) {
      const { page: head } = await call("read", { principal: owner, pageId: page.pageId });
      await call("edit", { principal: owner, pageId: page.pageId, baseRevision: head.headRevision, body });
    }

    assert.deepEqual(await call("readState", { principal: viewer, pageId: page.pageId }), { revision: null },
      "nobody has read it before they open it");
    assert.deepEqual(await call("markRead", { principal: viewer, pageId: page.pageId, revision: 2 }), { revision: 2 });
    assert.deepEqual(await call("markRead", { principal: viewer, pageId: page.pageId, revision: 1 }), { revision: 2 },
      "it never moves back");
    assert.deepEqual(await call("markRead", { principal: viewer, pageId: page.pageId, revision: 99 }), { revision: 3 },
      "nor past the page's head");
    assert.deepEqual(await call("readState", { principal: owner, pageId: page.pageId }), { revision: null },
      "each person has their own");
    await assert.rejects(call("readState", { principal: agent, pageId: page.pageId }), code("page_read_state_human_only"));
    await assert.rejects(call("markRead", { principal: agent, pageId: page.pageId, revision: 1 }),
      code("page_read_state_human_only"));
    await assert.rejects(call("markRead", { principal: { kind: "user", id: "stranger" }, pageId: page.pageId, revision: 1 }),
      code("space_not_found"), "only someone who can read the page has read it");

    await call("remove", { principal: owner, pageId: page.pageId });
    const { rows } = await client.query("SELECT 1 FROM data.page_reads WHERE space_id=$1", [ids.space]);
    assert.equal(rows.length, 0, "removing the page removes how far anyone read it");
  } finally {
    await cleanup(client, ids);
    await client.end();
  }
});

integration("pages: recent changes are the readable pages that changed last, each with its section and what it added", async () => {
  const { client, ids, pages, owner, member } = await pageTest("page-recent");
  try {
    const call = (method, input) => pages[method]({ spaceId: ids.space, ...input, requestId: crypto.randomUUID() });
    const { page: plan } = await call("create", { principal: owner, title: "Plan", body: "# Plan\n\n## Goals\n- ship\n" });
    const { page: notes } = await call("create", { principal: owner, title: "Notes", body: "Hello\n" });
    await call("create", { principal: owner, title: "Finance", accessMode: "restricted" });
    await call("edit", { principal: owner, pageId: plan.pageId, baseRevision: 1,
      body: "# Plan\n\n## Goals\n- ship\n- **Sentry** native install [passed](https://example.com)\n" });
    const shown = (changes) => changes.map((change) => [change.title, change.block?.id ?? null, change.gist, change.created]);

    assert.deepEqual(shown((await call("recentChanges", { principal: member })).changes), [
      ["Plan", "goals", "Sentry native install passed", false],
      ["Notes", null, null, true],
    ], "newest first; a restricted page is not among a member's changes");
    assert.deepEqual(shown((await call("recentChanges", { principal: owner })).changes).map(([title]) => title),
      ["Plan", "Finance", "Notes"]);
    const [latest] = (await call("recentChanges", { principal: owner, limit: 1 })).changes;
    assert.equal(latest.revision, 2);
    assert.equal(latest.block.title, "Goals");
    assert.deepEqual(latest.authors.map((author) => author.id), [ids.owner]);

    await call("edit", { principal: member, pageId: notes.pageId, baseRevision: 1, body: "" });
    assert.deepEqual(shown((await call("recentChanges", { principal: member, limit: 1 })).changes),
      [["Notes", null, null, false]], "a change that only removed text has no gist");
  } finally {
    await cleanup(client, ids);
    await client.end();
  }
});

integration("pages: search reads titles and section text, and skips pages the reader cannot open", async () => {
  const { client, ids, pages, owner, member } = await pageTest("page-search");
  try {
    const call = (method, input) => pages[method]({ spaceId: ids.space, ...input, requestId: crypto.randomUUID() });
    await call("create", { principal: owner, title: "Plan", body: "# Plan\n\n## Goals\nship the ledger\n" });
    await call("create", { principal: owner, title: "Finance", body: "# Finance\nsecret ledger\n", accessMode: "restricted" });
    await call("create", { principal: owner, title: "Notes", body: "nothing\n" });
    const shown = (results) => results.map((hit) => [hit.title, hit.field, hit.blockId]).sort();

    assert.deepEqual(shown((await call("search", { principal: member, query: "LEDGER" })).results), [
      ["Plan", "body", "goals"],
    ]);
    assert.deepEqual(shown((await call("search", { principal: owner, query: "ledger" })).results), [
      ["Finance", "body", "finance"],
      ["Plan", "body", "goals"],
    ]);
    assert.deepEqual(shown((await call("search", { principal: member, query: "notes" })).results), [
      ["Notes", "title", ""],
    ]);
    assert.deepEqual((await call("search", { principal: member, query: "finance" })).results, []);
    await assert.rejects(call("search", { principal: member, query: "  " }), code("invalid_request"));
  } finally {
    await cleanup(client, ids);
    await client.end();
  }
});

integration("pages: members co-edit with a freshness gate, structure is human, access is inherited", async () => {
  const { client, ids, pages, owner, member, viewer, agent } = await pageTest("pages");
  try {
    const r = () => crypto.randomUUID();
    const base = { requestId: "", spaceId: ids.space };
    const call = (method, input) => pages[method]({ ...base, ...input, requestId: r() });

    const { page: company } = await call("create", { principal: owner, title: "Company", body: "# Company\n\nStatus: new\n" });
    await assert.rejects(call("create", { principal: member, title: "Second root" }), code("page_root_admin_only"),
      "only owners and admins add top-level pages once one exists");
    const { page: project } = await call("create", { principal: member, parentPageId: company.pageId, title: "Project" });
    await assert.rejects(call("create", { principal: viewer, parentPageId: company.pageId, title: "Nope" }),
      code("page_edit_forbidden"));
    const { page: agentPage } = await call("create", { principal: agent, parentPageId: company.pageId, title: "Agent page" });
    assert.equal(agentPage.parentPageId, company.pageId, "an Agent adds pages as its owner may");
    assert.equal((await call("remove", { principal: agent, pageId: agentPage.pageId })).removed, true,
      "and removes them");

    const read = await call("read", { principal: viewer, pageId: project.pageId });
    assert.equal(read.page.canEdit, false);
    assert.equal(read.page.body, "# Project\n");

    const first = await call("edit", { principal: member, pageId: project.pageId, baseRevision: 1,
      body: "# Project\n\n## Status\n\nIn progress\n" });
    assert.equal(first.revision.revision, 2);
    const stale = await call("edit", { principal: owner, pageId: project.pageId, baseRevision: 1,
      body: "# Project\n\nOverwrite\n" }).then(() => null, (error) => error);
    assert.equal(stale.code, "page_revision_conflict");
    assert.equal(stale.detail.headRevision, 2);
    assert.match(stale.detail.body, /In progress/u, "a stale edit gets the current head to rebase on");
    await assert.rejects(call("edit", { principal: viewer, pageId: project.pageId, baseRevision: 2, body: "x" }),
      code("page_edit_forbidden"));

    // An Agent edits with its owner's access and links the page to its conversation.
    const agentEdit = await call("edit", { principal: agent, pageId: project.pageId, baseRevision: 2,
      body: "# Project\n\n## Status\n\nShipped\n", conversationIds: [ids.open], blockIds: ["status"] });
    assert.equal(agentEdit.revision.kind, "edit");
    assert.deepEqual(agentEdit.revision.authors.map((author) => [author.kind, author.ownerUserId]),
      [["agent", ids.member]]);
    const links = await call("links", { principal: owner, pageId: project.pageId });
    assert.deepEqual(links.links.map((link) => [link.conversationId, link.blockId, link.source]),
      [[ids.open, "status", "edit"]]);
    await assert.rejects(call("edit", { principal: agent, pageId: project.pageId, baseRevision: 3,
      body: "x", conversationIds: [ids.closed] }), (error) => error.status === 404,
    "an Agent cannot link a conversation its owner cannot read");

    // Suggest-only: the Agent's edit waits for a human.
    await call("update", { principal: owner, pageId: project.pageId, agentSuggestOnly: true });
    const suggestion = await call("edit", { principal: agent, pageId: project.pageId, baseRevision: 1,
      body: "# Project\n\n## Status\n\nSuggested\n" });
    assert.equal(suggestion.revision.kind, "suggestion");
    assert.equal(suggestion.page.headRevision, 3, "a suggestion never becomes the head by itself");
    await assert.rejects(call("promote", { principal: agent, pageId: project.pageId,
      revision: suggestion.revision.revision, baseRevision: 3 }), code("page_suggest_only"),
    "on a suggest-only page a person accepts the Agent's suggestion");
    const accepted = await call("promote", { principal: member, pageId: project.pageId,
      revision: suggestion.revision.revision, baseRevision: 3 });
    assert.equal(accepted.revision.kind, "accepted");
    assert.deepEqual(accepted.revision.authors.map((author) => author.kind).sort(), ["agent", "user"],
      "accepting keeps the Agent as a co-author");
    const history = await call("history", { principal: viewer, pageId: project.pageId });
    assert.deepEqual(history.revisions.map((rev) => rev.kind), ["accepted", "suggestion", "edit", "edit", "edit"]);

    // Restricted pages and inheritance.
    const { page: finance } = await call("create", { principal: owner, parentPageId: company.pageId,
      title: "Finance", accessMode: "restricted" });
    const { page: payroll } = await call("create", { principal: owner, parentPageId: finance.pageId, title: "Payroll" });
    const memberTree = await call("tree", { principal: member });
    assert.deepEqual(memberTree.pages.map((page) => page.title).sort(), ["Company", "Project"],
      "a restricted page and its descendants are invisible without a grant");
    await assert.rejects(call("update", { principal: member, pageId: project.pageId, accessMode: "restricted" }),
      code("page_access_admin_only"));
    await call("update", { principal: owner, pageId: finance.pageId, access: [{ userId: ids.member, access: "read" }] });
    const granted = await call("read", { principal: member, pageId: payroll.pageId });
    assert.equal(granted.page.canEdit, false, "descendants inherit the nearest restriction");
    await assert.rejects(call("edit", { principal: agent, pageId: payroll.pageId, baseRevision: 1, body: "x" }),
      code("page_edit_forbidden"), "an Agent has no more access than its owner");

    // Structure rules.
    await assert.rejects(call("update", { principal: owner, pageId: company.pageId, parentPageId: payroll.pageId }),
      code("page_move_cycle"));
    await assert.rejects(call("remove", { principal: owner, pageId: finance.pageId }), code("page_has_children"));
    await call("update", { principal: owner, pageId: payroll.pageId, parentPageId: company.pageId, afterPageId: project.pageId });
    const ordered = (await call("tree", { principal: owner })).pages
      .filter((page) => page.parentPageId === company.pageId).map((page) => page.title);
    assert.equal(ordered.indexOf("Payroll"), ordered.indexOf("Project") + 1, "afterPageId places a page right after its sibling");

    // Purge redacts every revision in place.
    await call("edit", { principal: owner, pageId: project.pageId, baseRevision: accepted.page.headRevision,
      body: "# Project\n\ntoken sk-live-secret\n" });
    await assert.rejects(call("purge", { principal: member, pageId: project.pageId, needle: "sk-live-secret" }),
      code("page_purge_admin_only"));
    const purged = await call("purge", { principal: owner, pageId: project.pageId, needle: "sk-live-secret" });
    assert.equal(purged.redactedRevisions, 1);
    const clean = await call("read", { principal: owner, pageId: project.pageId });
    assert.doesNotMatch(clean.page.body, /sk-live-secret/u);

    // A message's page references link the pages its author may read, and nothing else.
    const referenced = await pages.linkReferences({ requestId: r(), conversationId: ids.open, principal: member,
      pageIds: [project.pageId, finance.pageId, crypto.randomUUID()] });
    assert.deepEqual(referenced.linked.sort(), [project.pageId, finance.pageId].sort(),
      "an unknown page id is ignored");
    const viewerReferenced = await pages.linkReferences({ requestId: r(), conversationId: ids.open, principal: viewer,
      pageIds: [finance.pageId] });
    assert.deepEqual(viewerReferenced.linked, [], "a page the author cannot read is never linked");
    const conversationLinks = await call("links", { principal: member, conversationId: ids.open });
    assert.ok(conversationLinks.links.some((link) => link.pageId === project.pageId));
    // A Run's mirror gets the same pages, whole at their heads, in one call; a reader sees only the pages
    // they may read, and a conversation they cannot read is refused.
    const mirrored = async (principal) => {
      const { spaceId, pages: documents } = await pages.conversationPages({ requestId: r(), conversationId: ids.open,
        principal });
      assert.equal(spaceId, ids.space);
      const pageIds = [...new Set((await call("links", { principal, conversationId: ids.open })).links
        .map((link) => link.pageId))];
      assert.deepEqual(documents.map((document) => document.pageId), pageIds, "most recently linked first");
      for (const document of documents) {
        assert.deepEqual(document, (await call("read", { principal, pageId: document.pageId })).page);
      }
      return documents.map((document) => document.title).sort();
    };
    assert.deepEqual(await mirrored(member), ["Finance", "Project"]);
    assert.deepEqual(await mirrored(viewer), ["Project"]);
    await assert.rejects(pages.conversationPages({ requestId: r(), conversationId: ids.closed, principal: viewer }),
      (error) => error.status === 403 || error.status === 404);

    assert.equal(await pages.exists({ requestId: r(), spaceId: ids.space, pageId: payroll.pageId }), true);
    const removed = await call("remove", { principal: owner, pageId: payroll.pageId });
    assert.equal(removed.removed, true);
    assert.equal(await pages.exists({ requestId: r(), spaceId: ids.space, pageId: payroll.pageId }), false);
  } finally {
    await cleanup(client, ids);
    await client.end();
  }
});

integration("public pages: an owner publishes a page every member reads, and anyone reads it until it is taken down", async () => {
  const { client, ids, pages, owner, member } = await pageTest("public");
  try {
    const r = () => crypto.randomUUID();
    const create = (title, extra = {}) => pages.create({ requestId: r(), spaceId: ids.space, principal: owner,
      title, body: `# ${title}\n\nHow it stands.\n`, ...extra });
    const roadmap = (await create("Roadmap")).page;
    const q4 = (await create("Q4", { parentPageId: roadmap.pageId })).page;
    const draft = (await create("Draft", { parentPageId: roadmap.pageId })).page;
    const finance = (await create("Finance", { accessMode: "restricted" })).page;
    const budget = (await create("Budget", { parentPageId: finance.pageId })).page;
    const publish = (principal, pageId, published = true) => pages.publish({ requestId: r(), spaceId: ids.space,
      pageId, principal, published });
    const read = (pageId) => pages.publicRead({ requestId: r(), spaceId: ids.space, pageId });

    await assert.rejects(read(roadmap.pageId), code("page_not_found"), "nothing is public until published");
    await assert.rejects(publish(member, roadmap.pageId), code("page_publish_admin_only"));
    await assert.rejects(publish(owner, finance.pageId), code("page_not_publishable"));
    await assert.rejects(publish(owner, budget.pageId), code("page_not_publishable"),
      "a page below a restricted page is not open to every member either");

    const published = await publish(owner, roadmap.pageId);
    assert.equal(typeof published.page.publishedAt, "string");
    await publish(owner, q4.pageId);
    const { page } = await read(roadmap.pageId);
    assert.equal(page.title, "Roadmap");
    assert.equal(page.spaceName, "Pages test");
    assert.equal(page.body, "# Roadmap\n\nHow it stands.\n");
    assert.deepEqual(page.authors, [{ kind: "user", label: "Owner" }]);
    assert.deepEqual(page.children, [{ pageId: q4.pageId, title: "Q4" }], "only published children are listed");
    await assert.rejects(read(draft.pageId), code("page_not_found"));

    // Restricting the page later takes it off the public web without unpublishing it.
    await pages.update({ requestId: r(), spaceId: ids.space, pageId: roadmap.pageId, principal: owner,
      accessMode: "restricted" });
    await assert.rejects(read(roadmap.pageId), code("page_not_found"));
    await assert.rejects(read(q4.pageId), code("page_not_found"), "a restricted page above hides it too");
    await pages.update({ requestId: r(), spaceId: ids.space, pageId: roadmap.pageId, principal: owner,
      accessMode: "open" });
    assert.equal((await read(roadmap.pageId)).page.title, "Roadmap");

    await publish(owner, roadmap.pageId, false);
    await assert.rejects(read(roadmap.pageId), code("page_not_found"), "taken down, it is gone");
    assert.equal((await read(q4.pageId)).page.title, "Q4", "each page is published on its own");
  } finally {
    await cleanup(client, ids);
    await client.end();
  }
});

integration("claims: one holder per block, renewed by its holder, open for competition on an owner's word", async () => {
  const { client, ids, pages, owner, member, viewer, agent } = await pageTest("claims");
  try {
    const r = () => crypto.randomUUID();
    const { page } = await pages.create({ requestId: r(), spaceId: ids.space, principal: owner,
      title: "Roadmap", body: "# Roadmap\n\n## Search\n\nNext.\n" });
    const base = { spaceId: ids.space, pageId: page.pageId };
    const claim = (principal, extra = {}) => pages.claim({ requestId: r(), ...base, principal, blockId: "search", ...extra });
    const list = () => pages.claims({ requestId: r(), ...base, principal: member });

    const first = (await claim(agent, { minutes: 30 })).claim;
    assert.deepEqual(first.holder, { kind: "agent", id: ids.instance, label: "claude:1" });
    assert.equal(first.ownerUserId, ids.member, "an Agent's claim counts against its owner");
    await assert.rejects(claim(owner), (error) => error.code === "page_block_claimed"
      && error.message === "claude:1 is on this");
    await assert.rejects(claim(viewer), code("page_edit_forbidden"));
    await assert.rejects(claim(agent, { minutes: 1 }), code("invalid_request"));
    assert.equal((await claim(owner, { blockId: "" })).claim.blockId, "", "the whole page is its own block");

    const renewed = (await claim(agent, { minutes: 60 })).claim;
    assert.equal(renewed.claimId, first.claimId, "its holder renews the claim instead of taking another");
    assert.ok(renewed.expiresAt > first.expiresAt);

    await assert.rejects(pages.setCompetition({ requestId: r(), ...base, principal: member, blockId: "search", open: true }),
      code("page_competition_admin_only"));
    await pages.setCompetition({ requestId: r(), ...base, principal: owner, blockId: "search", open: true });
    const rival = (await claim(owner)).claim;
    assert.deepEqual((await list()).competitiveBlocks, ["search"]);
    assert.deepEqual((await list()).claims.map((c) => c.claimId).sort(),
      [first.claimId, rival.claimId, (await list()).claims.find((c) => c.blockId === "").claimId].sort());

    assert.deepEqual(await pages.releaseClaim({ requestId: r(), ...base, principal: viewer, claimId: first.claimId }),
      { released: false }, "only its holder, its owner or an admin releases a claim");
    assert.deepEqual(await pages.releaseClaim({ requestId: r(), ...base, principal: member, claimId: first.claimId }),
      { released: true, blockId: "search" }, "the owner of the Agent releases its claim");
    await client.query("UPDATE data.page_claims SET expires_at=now() - interval '1 second' WHERE claim_id=$1",
      [rival.claimId]);
    assert.deepEqual((await list()).claims.map((c) => c.blockId), [""], "an expired claim is no longer in force");
    await pages.setCompetition({ requestId: r(), ...base, principal: owner, blockId: "search", open: false });
    assert.equal((await claim(agent)).claim.holder.id, ids.instance, "a lapsed claim frees the block");
  } finally {
    await cleanup(client, ids);
    await client.end();
  }
});

integration("a page's conversations are described to readers only, with their newest message and live Agents", async () => {
  const { client, ids } = await pageTest("page-conversations");
  try {
    const db = database(client);
    const read = (userId, conversationIds) => readPageConversations(db, { requestId: crypto.randomUUID(),
      spaceId: ids.space, principal: { kind: "user", id: userId }, conversationIds });
    for (const [sequence, body] of [[1, "First"], [2, "Ship it"]]) {
      await client.query(`INSERT INTO data.messages
        (space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
         message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,search_rank_sequence,
         legacy_body,created_at)
        VALUES ($1,$2,$3,$4,1,'user',$5,'message','hash','inline','inline',
          now() + $7::int * interval '1 second',now() + $7::int * interval '1 second',$3,$6,now())`,
      [ids.space, ids.open, `${ids.open}-m${sequence}`, sequence, ids.owner, body, sequence]);
    }
    await client.query(`INSERT INTO data.delivery_cursors
      (space_id,channel_id,subject_id,acknowledged_sequence,version,updated_at)
      VALUES ($1,$2,$3,1,1,now())`, [ids.space, ids.open, `user:${ids.member}`]);
    await addSleepingInstance(client, ids);

    const [open, ...others] = await read(ids.member, [ids.open, ids.closed]);
    assert.deepEqual(others, [], "a conversation the reader cannot open is not described");
    assert.equal(open.conversationId, ids.open);
    assert.equal(open.name, ids.open);
    assert.equal(open.headSequence, 2);
    assert.equal(open.readSequence, 1, "how far this reader has read");
    assert.deepEqual({ ...open.head, sentAt: undefined }, { messageId: `${ids.open}-m2`, sequence: 2,
      authorKind: "user", authorId: ids.owner, sentAt: undefined, recalledAt: null, preview: null,
      payloadBundleBase64: null, legacyBody: "Ship it" }, "the newest message");
    assert.deepEqual(open.agents.map(({ instanceId, name, status }) => ({ instanceId, name, status })),
      [{ instanceId: ids.instance, name: "claude:1", status: "online" }], "the Agents live in it, not the sleeping one");
    assert.ok(Date.parse(open.activityAt) >= Date.parse(open.head.sentAt));

    const asOwner = await read(ids.owner, [ids.open, ids.closed]);
    assert.deepEqual(asOwner.map((conversation) => conversation.conversationId).sort(), [ids.closed, ids.open].sort());
    assert.equal(asOwner.find((conversation) => conversation.conversationId === ids.closed).head, null);
    assert.deepEqual(await read(ids.owner, []), []);
    await assert.rejects(read(ids.owner, Array.from({ length: 101 }, (_, index) => `c-${index}`)),
      code("invalid_request"));
    await assert.rejects(read(`${ids.space}-stranger`, [ids.open]), code("space_not_found"));
  } finally {
    await client.query("DELETE FROM data.delivery_cursors WHERE space_id=$1", [ids.space]).catch(() => {});
    await client.query("DELETE FROM data.messages WHERE space_id=$1", [ids.space]).catch(() => {});
    await cleanup(client, ids);
    await client.end();
  }
});

integration("the page tree shows each page's Agents: live in a conversation whose current Run read or edited it", async () => {
  const { client, ids, pages, owner, member, agent } = await pageTest("page-agents");
  try {
    const r = () => crypto.randomUUID();
    const call = (method, input) => pages[method]({ spaceId: ids.space, ...input, requestId: r() });
    const onPages = async (principal) => Object.fromEntries((await call("agentsOnPages", { principal })).pages
      .filter(({ agents }) => agents.length > 0)
      .map(({ pageId, agents }) => [pageId, agents.map(({ instanceId, name, status, conversationId, activity, blockId,
        section }) => ({ instanceId, name, status, conversationId, activity, blockId, ...(section ? { section } : {}) }))]));

    const { page: company } = await call("create", { principal: owner, title: "Company" });
    const { page: project } = await call("create", { principal: owner, parentPageId: company.pageId, title: "Project" });
    const { page: quiet } = await call("create", { principal: owner, parentPageId: company.pageId, title: "Quiet" });
    assert.deepEqual(await onPages(member), {}, "nobody is on a page yet");

    await call("read", { principal: agent, pageId: company.pageId, conversationId: ids.open });
    await call("edit", { principal: agent, pageId: project.pageId, baseRevision: 1,
      body: "# Project\n\n## Status\n\nShipped\n", conversationIds: [ids.open], blockIds: ["status"] });
    // A conversation with no live Run shows nobody.
    await call("read", { principal: owner, pageId: quiet.pageId, conversationId: ids.closed });
    // A sleeping Instance in the same conversation is on no page.
    await addSleepingInstance(client, ids);
    const live = { instanceId: ids.instance, name: "claude:1", status: "online", conversationId: ids.open };
    assert.deepEqual(await onPages(member), {
      [company.pageId]: [{ ...live, activity: "viewing", blockId: "" }],
      [project.pageId]: [{ ...live, activity: "editing", blockId: "status", section: "Status" }],
    }, "an Agent's section is named by its heading");

    // Each page lists its open discussions this reader may open; a plain link or a resolved one is not one.
    const discussions = async (principal) => Object.fromEntries((await call("agentsOnPages", { principal })).pages
      .filter((page) => page.discussions.length > 0).map(({ pageId, discussions }) => [pageId, discussions]));
    assert.deepEqual(await discussions(member), {}, "reading or editing a page opens no discussion");
    const anchor = { quote: "Shipped", from: { assoc: 0 }, to: { assoc: 0 } };
    await call("link", { principal: owner, pageId: project.pageId, conversationId: ids.open, blockId: "status",
      source: "manual", anchor });
    const { link: closed } = await call("link", { principal: owner, pageId: quiet.pageId, conversationId: ids.closed,
      source: "manual", anchor });
    assert.deepEqual(await discussions(member), { [project.pageId]: [ids.open] },
      "a discussion in a conversation the member cannot open is not theirs to see");
    assert.deepEqual(await discussions(owner), { [project.pageId]: [ids.open], [quiet.pageId]: [ids.closed] });
    await call("resolveLink", { principal: owner, linkId: closed.linkId, resolved: true });
    assert.deepEqual(await discussions(owner), { [project.pageId]: [ids.open] }, "a resolved discussion is closed");

    await client.query("UPDATE data.instances SET status='busy' WHERE instance_id=$1", [ids.instance]);
    assert.equal((await onPages(member))[project.pageId][0].status, "busy");

    // A later Run in the same conversation has not read the pages its predecessor did.
    await client.query("UPDATE data.instances SET created_at=now() + interval '1 minute', updated_at=now() + interval '1 minute' WHERE instance_id=$1",
      [ids.instance]);
    assert.deepEqual(await onPages(member), {});
    await client.query("UPDATE data.instances SET created_at=now() - interval '1 minute', updated_at=now() WHERE instance_id=$1",
      [ids.instance]);
    await client.query("UPDATE data.runs SET status='stopped' WHERE run_id=$1", [ids.run]);
    assert.deepEqual(await onPages(member), {}, "an ended Run is on no page");

    await assert.rejects(onPages({ kind: "user", id: `${ids.space}-stranger` }), code("space_not_found"));
  } finally {
    await cleanup(client, ids);
    await client.end();
  }
});
