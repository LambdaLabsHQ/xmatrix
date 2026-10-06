import { postgresDatabase as database, connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "pg";

import {
  PostgresPageMigrationRepository, migratedPageId, revisedDraft, validDraft,
} from "../dist/page-migration.js";
import { PostgresPageRepository } from "../dist/page-control.js";



const page = (key, parentKey, sources = []) => ({ key, parentKey, title: `Title ${key}`, body: `# ${key}\n`, sources });

test("a draft names parents before children, with unique keys", () => {
  assert.throws(() => validDraft({ pages: [page("b", "a"), page("a", null)] }),
    (error) => error.code === "invalid_page_migration_draft");
  assert.throws(() => validDraft({ pages: [page("a", null), page("a", null)] }),
    (error) => error.code === "invalid_page_migration_draft");
  assert.throws(() => validDraft({ pages: [] }), (error) => error.code === "invalid_page_migration_draft");
  assert.deepEqual(validDraft({ pages: [page("a", null, ["c", "c"])] }).pages[0].sources, ["c"]);
});

test("dropping a page moves its children up to the nearest kept ancestor", () => {
  const draft = validDraft({ pages: [page("a", null), page("b", "a"), page("c", "b"), page("d", null)] });
  const revised = revisedDraft(draft, new Set(["b"]), { d: "Renamed" });
  assert.deepEqual(revised.pages.map((p) => [p.key, p.parentKey, p.title]),
    [["a", null, "Title a"], ["c", "a", "Title c"], ["d", null, "Renamed"]]);
});

test("a draft page's id is stable and UUID-shaped", async () => {
  const id = await migratedPageId("space-1", "relay");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(id, await migratedPageId("space-1", "relay"));
  assert.notEqual(id, await migratedPageId("space-2", "relay"));
});

integration("a drafted page tree is submitted, revised, and applied once, with readers as of applying", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  const id = `migr-${crypto.randomUUID()}`;
  const ids = { space: `${id}-space`, owner: `${id}-owner`, member: `${id}-member`,
    general: `${id}-general`, finance: `${id}-finance`, board: `${id}-board`, missing: `${id}-missing` };
  try {
    await client.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ('shard-0','active','test',now(),now()) ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,target_shard_id,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active',NULL,'test',now(),now())`, [ids.space]);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,'Migration test',$1,1,'{}',now(),now())`, [ids.space, ids.owner]);
    for (const [userId, role] of [[ids.owner, "owner"], [ids.member, "member"]]) {
      await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
        VALUES ($1,$2,$3,1,now(),now())`, [ids.space, userId, role]);
    }
    for (const [channelId, mode, metadata] of [[ids.general, "open", {}], [ids.finance, "closed", {}],
      [ids.board, "closed", {}]]) {
      await client.query(`INSERT INTO data.channels
        (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
         metadata_json,created_at,updated_at)
        VALUES ($1,$2,$1,$1,$3,$1,1,$4::jsonb,now(),now())`,
      [channelId, ids.space, mode, JSON.stringify(metadata)]);
    }
    for (const [channelId, userId] of [[ids.finance, ids.owner], [ids.finance, ids.member], [ids.board, ids.owner]]) {
      await client.query(`INSERT INTO data.channel_access
        (space_id,channel_id,subject_kind,subject_id,grant_version,created_at,updated_at)
        VALUES ($1,$2,'user',$3,1,now(),now())`, [ids.space, channelId, userId]);
    }
    // A plan from before drafts existed is no draft.
    await client.query(`INSERT INTO data.page_migrations (space_id,state,plan_json,proposed_at,version)
      VALUES ($1,'proposed','{"pages":[]}'::jsonb,now(),3)`, [ids.space]);

    const migrations = new PostgresPageMigrationRepository(database(client));
    const pages = new PostgresPageRepository(database(client));
    const r = () => crypto.randomUUID();
    const owner = { kind: "user", id: ids.owner, label: "Owner" };
    const member = { kind: "user", id: ids.member, label: "Member" };
    await assert.rejects(migrations.get({ requestId: r(), spaceId: ids.space, principal: member }),
      (error) => error.code === "page_migration_admin_only");
    assert.equal((await migrations.get({ requestId: r(), spaceId: ids.space, principal: owner })).state, "none");

    const draft = { pages: [
      { key: "company", parentKey: null, title: "Company", body: "# Company\n\nWhat we do.\n", sources: [ids.general] },
      { key: "finance", parentKey: "company", title: "Finance", body: "# Finance\n\nRunway: 18 months.\n",
        sources: [ids.finance] },
      { key: "board", parentKey: "company", title: "Board", body: "# Board\n\nNext meeting in May.\n",
        sources: [ids.finance, ids.board] },
      { key: "notes", parentKey: null, title: "Notes", body: "# Notes\n", sources: [] },
    ] };
    await assert.rejects(migrations.submit({ requestId: r(), spaceId: ids.space, principal: owner, version: 0,
      draft: { pages: [{ ...draft.pages[0], sources: [ids.missing] }] } }),
    (error) => error.code === "page_migration_source_forbidden", "an unknown conversation is never a source");
    await assert.rejects(migrations.submit({ requestId: r(), spaceId: ids.space, principal: member, version: 0, draft }),
      (error) => error.code === "page_migration_admin_only");
    // Two first drafts race: exactly one is stored, the other must read it and replace it by version.
    const second = new Client({ connectionString });
    await second.connect();
    let submitted;
    try {
      const racing = await Promise.allSettled([migrations, new PostgresPageMigrationRepository(database(second))]
        .map((repository) => repository.submit({ requestId: r(), spaceId: ids.space, principal: owner, version: 0, draft })));
      assert.deepEqual(racing.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
      assert.equal(racing.find((result) => result.status === "rejected").reason.code, "page_migration_conflict");
      submitted = racing.find((result) => result.status === "fulfilled").value;
    } finally {
      await second.end();
    }
    assert.equal(submitted.state, "proposed");
    assert.deepEqual(submitted.drafter, { kind: "user", id: ids.owner, label: "Owner" });
    assert.deepEqual(submitted.sources.filter((s) => s.closed).map((s) => s.conversationId).sort(),
      [ids.board, ids.finance].sort());
    await assert.rejects(migrations.submit({ requestId: r(), spaceId: ids.space, principal: owner, version: 0, draft }),
      (error) => error.code === "page_migration_conflict", "a submission names the draft it replaces");

    const revised = await migrations.revise({ requestId: r(), spaceId: ids.space, principal: owner,
      version: submitted.version, drop: ["company"], titles: { notes: "Open questions" } });
    assert.deepEqual(revised.draft.pages.map((p) => [p.key, p.parentKey, p.title]),
      [["finance", null, "Finance"], ["board", null, "Board"], ["notes", null, "Open questions"]]);
    await assert.rejects(migrations.apply({ requestId: r(), spaceId: ids.space, principal: owner,
      version: submitted.version }), (error) => error.code === "page_migration_conflict");

    // A page someone already wrote by hand stays, and the new pages follow it.
    const manual = await pages.create({ requestId: r(), spaceId: ids.space, principal: owner, title: "Handbook" });
    // Readers are taken when the draft is applied, not when it was written.
    await client.query(`INSERT INTO data.channel_access
      (space_id,channel_id,subject_kind,subject_id,grant_version,created_at,updated_at)
      VALUES ($1,$2,'user',$3,1,now(),now())`, [ids.space, ids.board, ids.member]);
    const applied = await migrations.apply({ requestId: r(), spaceId: ids.space, principal: owner,
      version: revised.version });
    assert.equal(applied.state, "applied");
    assert.deepEqual(applied.report, { pages: 3, links: 3, restrictedPages: 2 });
    assert.deepEqual(applied.draft, { pages: [] }, "the pages own the text once applied");
    const stored = (await client.query("SELECT plan_json FROM data.page_migrations WHERE space_id=$1", [ids.space]))
      .rows[0].plan_json;
    assert.equal(JSON.stringify(stored).includes("Next meeting"), false);
    assert.deepEqual(stored.pages.map((entry) => entry.key), ["finance", "board", "notes"]);

    const tree = await pages.tree({ requestId: r(), spaceId: ids.space, principal: member });
    const byTitle = new Map(tree.pages.map((p) => [p.title, p]));
    assert.deepEqual([...byTitle.keys()].sort(), ["Board", "Finance", "Handbook", "Open questions"]);
    assert.ok(byTitle.get("Handbook").position < byTitle.get("Finance").position);
    assert.equal(byTitle.get("Handbook").pageId, manual.page.pageId);
    assert.equal(byTitle.get("Board").accessMode, "restricted");
    const board = await pages.read({ requestId: r(), spaceId: ids.space, principal: member,
      pageId: await migratedPageId(ids.space, "board") });
    assert.equal(board.page.body, "# Board\n\nNext meeting in May.\n");
    assert.deepEqual(board.page.revisionInfo.authors, [{ kind: "user", id: ids.owner, label: "Owner" }]);
    const links = await pages.links({ requestId: r(), spaceId: ids.space, principal: owner,
      pageId: await migratedPageId(ids.space, "board") });
    assert.deepEqual(links.links.map((link) => [link.conversationId, link.source]).sort(),
      [[ids.board, "migration"], [ids.finance, "migration"]].sort());

    // Applying again returns what was applied and never restores access removed since.
    await client.query("DELETE FROM data.page_access WHERE space_id=$1 AND subject_id=$2", [ids.space, ids.member]);
    const again = await migrations.apply({ requestId: r(), spaceId: ids.space, principal: owner,
      version: revised.version });
    assert.deepEqual(again.report, applied.report);
    assert.equal((await client.query("SELECT 1 FROM data.page_access WHERE space_id=$1 AND subject_id=$2",
      [ids.space, ids.member])).rows.length, 0);
    await assert.rejects(migrations.submit({ requestId: r(), spaceId: ids.space, principal: owner,
      version: again.version, draft }), (error) => error.code === "page_migration_applied");
  } finally {
    for (const table of ["page_links", "page_access", "page_revisions", "pages", "page_migrations",
      "channel_access", "channels", "space_members", "spaces"]) {
      await client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [ids.space]).catch(() => {});
    }
    await client.query("DELETE FROM control.space_placement WHERE space_id=$1", [ids.space]).catch(() => {});
    await client.end();
  }
});
