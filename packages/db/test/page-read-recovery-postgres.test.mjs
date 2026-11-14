import assert from "node:assert/strict";
import { DatabaseCommitUnknownError, PostgresPageRepository } from "../dist/index.js";
import { integration } from "./postgres-database.fixture.mjs";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";
import { recoveringDatabase } from "./response-fault-postgres.fixture.mjs";

function count(clients, pattern) {
  return clients.reduce((total, client) => total + client.queries.filter((sql) => pattern.test(sql)).length, 0);
}

// HUB-CX lost BEGIN on page.read before any statement. A read with no
// conversation link is lock-free. A read that records a link replays once
// before COMMIT and does not replay an unknown COMMIT or an answered error.
integration("page.read recovers a lost BEGIN without replaying a commit (XMATRIX-HUB-CX)", async () => {
  const f = await spaceSecretFixture();
  let fault;
  const { database, clients } = recoveringDatabase(() => fault);
  const pages = new PostgresPageRepository(database);
  const input = { requestId: crypto.randomUUID(), spaceId: f.ids.space,
    principal: { kind: "user", id: f.ids.owner } };
  let page;
  const links = () => f.client.query(
    "SELECT count(*)::int AS n FROM data.page_links WHERE space_id=$1 AND page_id=$2",
    [f.ids.space, page.pageId]);
  try {
    ({ page } = await pages.create({ ...input, title: "Read recovery", body: "Recovered body" }));
    const read = () => pages.read({ ...input, pageId: page.pageId });
    const expected = await read();
    assert.equal(expected.page.body, "Recovered body");
    assert.equal((await links()).rows[0].n, 0);

    for (const matches of [/SELECT role FROM data\.space_members/u,
      /FROM data\.page_revisions WHERE space_id=\$1 AND page_id=\$2 AND revision=\$3/u]) {
      const before = clients.length;
      fault = { matches, remaining: 1, error: new Error("Query read timeout"), checkouts: [] };
      assert.equal((await read()).page.body, "Recovered body");
      assert.equal(fault.checkouts.length, 1);
      assert.equal(fault.checkouts[0].ended, true);
      assert.ok(clients.indexOf(fault.checkouts[0]) < clients.length - 1);
      assert.ok(clients.slice(before).every((entry) => entry.ended &&
        !entry.queries.some((sql) => /^(BEGIN|COMMIT)/u.test(sql))));
    }
    fault = { matches: /FROM data\.page_revisions WHERE space_id=\$1/u, remaining: 3,
      error: new Error("Query read timeout"), checkouts: [] };
    await assert.rejects(read(), /Query read timeout/u);
    assert.equal(fault.checkouts.length, 2, "a second lost read is not tried again");
    fault = { matches: /FROM data\.page_revisions WHERE space_id=\$1/u, remaining: 3,
      error: Object.assign(new Error("statement timeout"), { code: "57014" }), checkouts: [] };
    await assert.rejects(read(), /statement timeout/u);
    assert.equal(fault.checkouts.length, 1, "an answered read failure is not replayed");

    const linked = () => pages.read({ ...input, pageId: page.pageId, conversationId: f.ids.channel });
    fault = undefined;
    assert.equal((await linked()).page.pageId, page.pageId);
    assert.equal((await links()).rows[0].n, 1);
    const beforeBegin = count(clients, /^BEGIN/u);
    const beforeCommit = count(clients, /^COMMIT$/u);
    fault = { matches: /^BEGIN/u, remaining: 1, error: new Error("Query read timeout"), checkouts: [] };
    assert.equal((await linked()).page.body, "Recovered body");
    assert.equal(fault.checkouts.length, 1);
    assert.equal(fault.checkouts[0].ended, true);
    assert.ok(fault.checkouts[0].queries.some((sql) => sql.startsWith("BEGIN")));
    assert.ok(!fault.checkouts[0].queries.some((sql) => sql.includes("page_links")));
    assert.ok(clients.at(-1).queries.some((sql) => sql.includes("INSERT INTO data.page_links")));
    assert.equal(clients.at(-1).queries.at(-1), "COMMIT");
    assert.equal(count(clients, /^BEGIN/u), beforeBegin + 2);
    assert.equal(count(clients, /^COMMIT$/u), beforeCommit + 1);
    assert.equal((await links()).rows[0].n, 1);

    fault = { matches: /^BEGIN/u, remaining: 3, error: new Error("Query read timeout"), checkouts: [] };
    await assert.rejects(linked(), /Query read timeout/u);
    assert.equal(fault.checkouts.length, 2, "a second lost BEGIN is not tried again");
    fault = { matches: /INSERT INTO data\.page_links/u, remaining: 3,
      error: Object.assign(new Error("deadlock detected"), { code: "40P01" }), checkouts: [] };
    await assert.rejects(linked(), /deadlock detected/u);
    assert.equal(fault.checkouts.length, 1, "an answered write failure is not replayed");
    assert.equal((await links()).rows[0].n, 1);

    const commits = count(clients, /^COMMIT$/u);
    fault = { matches: /^COMMIT$/u, remaining: 1, error: new Error("Query read timeout"), checkouts: [] };
    await assert.rejects(linked(), (error) => error instanceof DatabaseCommitUnknownError);
    assert.equal(fault.checkouts.length, 1);
    assert.equal(count(clients, /^COMMIT$/u), commits + 1, "an unknown COMMIT is not replayed");
    assert.equal((await links()).rows[0].n, 1);
  } finally {
    fault = undefined;
    await f.client.query("DELETE FROM data.page_links WHERE space_id=$1", [f.ids.space]);
    await f.close();
  }
});
