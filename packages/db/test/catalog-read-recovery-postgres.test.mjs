import assert from "node:assert/strict";
import { Client } from "pg";
import { createAuthorityDatabase, PostgresAutomationRepository, PostgresBillingRepository, PostgresChannelCatalogRepository,
  PostgresPageRepository, PostgresSpaceControlRepository } from "../dist/index.js";
import { integration, connectionString } from "./postgres-database.fixture.mjs";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";
import { describePageConversations } from "../dist/page-conversations.js";

function recoveringDatabase(readFault) {
  const clients = [];
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0",
    clientFactory(config) {
      const client = new Client(config);
      const entry = { queries: [], ended: false };
      clients.push(entry);
      const query = client.query.bind(client);
      client.query = async input => {
        assert.equal(entry.ended, false, "a destroyed checkout cannot be reused");
        const text = typeof input === "string" ? input : input.text;
        entry.queries.push(text);
        const result = await query(input);
        const fault = readFault();
        if (fault?.matches.test(text) && fault.remaining > 0) {
          fault.remaining -= 1;
          fault.checkouts.push(entry);
          await fault.beforeThrow?.();
          throw fault.error;
        }
        return result;
      };
      const end = client.end.bind(client);
      client.end = async () => { entry.ended = true; await end(); };
      return client;
    },
  });
  return { database, clients };
}

async function assertReadRecovery(read, expected, clients, injectFault) {
  const before = clients.length;
  const fault = injectFault();
  assert.deepEqual(await read(), expected);
  assert.equal(fault.checkouts.length, 1);
  assert.ok(fault.checkouts[0].ended, "the stalled checkout is destroyed");
  assert.ok(clients.indexOf(fault.checkouts[0]) < clients.length - 1, "recovery uses a new connection");
  assert.ok(clients.slice(before).every(entry => entry.ended), "all request sessions close");
  assert.ok(clients.slice(before).every(entry => !entry.queries.some(sql => /^(BEGIN|COMMIT)/u.test(sql))),
    "lock-free reads avoid transaction-opening and commit round trips");
}

// The existing catalog privacy tests use healthy connections. Exercise the
// repository through the real client and SQL when a read response disappears,
// including a later access check: recovery must still redact private events.
integration("catalogs and page activity recover lost SELECTs without losing access checks (XMATRIX-HUB-96/8P/99)", async () => {
  const f = await spaceSecretFixture();
  const automationId = crypto.randomUUID();
  let fault;
  const { database, clients } = recoveringDatabase(() => fault);
  const repository = new PostgresAutomationRepository(database);
  const input = { requestId: crypto.randomUUID(), spaceId: f.ids.space,
    principal: { kind: "user", id: f.ids.owner } };
  try {
    await f.client.query(`INSERT INTO data.space_control_heads(space_id,commit_sequence,updated_at)
      VALUES($1,0,now())`, [f.ids.space]);
    const pages = new PostgresPageRepository(database);
    const { page } = await pages.create({ ...input,
      title: "Synthetic recovery audit", body: `[Recovery](xmatrix:automation/${automationId})` });
    await f.client.query(`INSERT INTO data.automations
      (automation_id,owner_user_id,channel_id,next_run_at,enabled,version,payload_json,trigger_events,page_id,created_at,updated_at)
      VALUES($1,$2,$3,now()+interval '1 day',true,1,$4::jsonb,$5::jsonb,$6,now(),now())`,
    [automationId, f.ids.owner, f.ids.channel, JSON.stringify({ payloadVersion: 2,
      intervalMinutes: 60, message: { body: "Synthetic recovery audit" } }),
    JSON.stringify([{ summary: "SYNTHETIC-PRIVATE-EVENT" }]), page.pageId]);
    for (const read of [() => repository.list(input),
      () => repository.listPage({ ...input, userId: f.ids.owner, pageId: page.pageId }),
      () => repository.get({ ...input, automationId })]) {
      for (const matches of [/FROM data\.automations t JOIN/u, /SELECT c\.channel_id\s+FROM data\.channels c JOIN data\.space_members/u]) {
        fault = { matches, remaining: 1, error: new Error("Query read timeout"), checkouts: [] };
        const result = await read();
        assert.equal((result.task ?? result.tasks[0]).id, automationId);
        assert.match(JSON.stringify(result), /SYNTHETIC-PRIVATE-EVENT/u);
        assert.equal(fault.checkouts.length, 1);
        assert.equal(fault.checkouts[0].ended, true, "the lost response's checkout is destroyed");
        assert.ok(clients.indexOf(fault.checkouts[0]) < clients.length - 1, "recovery checks out a new connection");
      }
    }
    const catalog = new PostgresChannelCatalogRepository(database);
    const catalogInput = { ...input, view: "flat", filter: "all" };
    // HUB-8P lost the counts response, after its page SELECT had succeeded.
    for (const read of [() => catalog.page(catalogInput),
      () => catalog.page({ ...catalogInput, countsOnly: true }),
      () => catalog.resolve({ ...input, channelIds: [f.ids.channel] })]) {
      fault = { matches: /counts AS \(SELECT|requested_targets AS MATERIALIZED/u,
        remaining: 1, error: new Error("Query read timeout"), checkouts: [] };
      const result = await read();
      if (result.counts) assert.equal(result.counts.active, 1);
      else assert.ok(JSON.stringify(result).includes(f.ids.channel));
      assert.equal(fault.checkouts.length, 1);
      assert.equal(fault.checkouts[0].ended, true);
      assert.ok(clients.indexOf(fault.checkouts[0]) < clients.length - 1);
    }
    // HUB-99 lost BEGIN while reading the page tree's Agent activity. Both
    // activity APIs are lock-free, including their conversation descriptions.
    await pages.read({ ...input, pageId: page.pageId, conversationId: f.ids.channel });
    await pages.link({ ...input, pageId: page.pageId, conversationId: f.ids.channel, source: "manual",
      anchor: { quote: "Recovery", from: { assoc: 0 }, to: { assoc: 0 } } });
    const activityReads = [
      () => pages.agentsOnPages({ ...input,
        describe: (tx, userId, ids) => describePageConversations(tx, f.ids.space, userId, ids) }),
      () => pages.links({ ...input, pageId: page.pageId,
        describe: (tx, userId, links) => describePageConversations(tx, f.ids.space, userId,
          links.map(link => link.conversationId)) }),
    ];
    const readCases = activityReads.map(read => ({ read, evidence: f.ids.instance,
      matches: [/SELECT role FROM data\.space_members/u, /FROM data\.page_links/u,
        /SELECT c\.channel_id, c\.name, c\.activity_at/u], failureMatch: /FROM data\.page_links/u }));
    readCases.push({ read: () => pages.search({ ...input, query: "Recovery" }), evidence: page.pageId,
      matches: [/SELECT role FROM data\.space_members/u, /data\.page_name\(r.body\) AS title, r.body/u],
      failureMatch: /data\.page_name\(r.body\) AS title, r.body/u });
    for (const { read, evidence, matches: stages, failureMatch } of readCases) {
      const expected = await read();
      assert.ok(JSON.stringify(expected).includes(evidence), "the accessible page or live activity is returned");
      for (const matches of stages) {
        await assertReadRecovery(read, expected, clients, () =>
          fault = { matches, remaining: 1, error: new Error("Query read timeout"), checkouts: [] });
      }
      fault = { matches: failureMatch, remaining: 3,
        error: new Error("Query read timeout"), checkouts: [] };
      await assert.rejects(read(), /Query read timeout/u);
      assert.equal(fault.checkouts.length, 2, "repeated loss is bounded");
      fault = { matches: failureMatch, remaining: 3,
        error: Object.assign(new Error("statement timeout"), { code: "57014" }), checkouts: [] };
      await assert.rejects(read(), /statement timeout/u);
      assert.equal(fault.checkouts.length, 1, "answered errors are not replayed");
      fault = undefined;
    }
    await f.client.query("UPDATE data.channels SET mode='closed' WHERE channel_id=$1", [f.ids.channel]);
    for (const read of activityReads) {
      fault = { matches: /SELECT role FROM data\.space_members/u, remaining: 1,
        error: new Error("Connection terminated unexpectedly"), checkouts: [] };
      const hidden = await read();
      assert.deepEqual(hidden.described, [], "recovery does not reveal an inaccessible conversation");
      assert.deepEqual(hidden.pages ?? hidden.links, []);
      assert.equal(fault.checkouts.length, 1);
    }
    fault = undefined;
    await f.client.query("UPDATE data.channels SET mode='open' WHERE channel_id=$1", [f.ids.channel]);
    await f.client.query("UPDATE data.space_members SET role='participant' WHERE space_id=$1 AND user_id=$2",
      [f.ids.space, f.ids.owner]);
    fault = { matches: /SELECT c\.channel_id\s+FROM data\.channels c JOIN data\.space_members/u,
      remaining: 1, error: new Error("Connection terminated unexpectedly"), checkouts: [] };
    const redacted = await repository.list(input);
    assert.equal(redacted.tasks[0].id, automationId);
    assert.doesNotMatch(JSON.stringify(redacted), /SYNTHETIC-PRIVATE-EVENT/u);
    assert.equal(fault.checkouts.length, 1);
    // Repeated loss stays bounded and propagates instead of returning an empty catalog.
    fault = { matches: /FROM data\.automations t JOIN/u,
      remaining: 3, error: new Error("Query read timeout"), checkouts: [] };
    await assert.rejects(repository.list(input), /Query read timeout/u);
    assert.equal(fault.checkouts.length, 2);
    // An answered SQL failure is never retried.
    fault = { matches: /FROM data\.automations t JOIN/u, remaining: 3,
      error: Object.assign(new Error("statement timeout"), { code: "57014" }), checkouts: [] };
    await assert.rejects(repository.list(input), /statement timeout/u);
    assert.equal(fault.checkouts.length, 1);
  } finally {
    await f.client.query("DELETE FROM data.page_links WHERE space_id=$1", [f.ids.space]);
    await f.client.query("DELETE FROM data.automations WHERE automation_id=$1", [automationId]);
    await f.close();
  }
});

// Healthy catalog tests cover authorization and presence, and the generic
// client tests cover retry. Neither catches a detail read opening BEGIN or
// losing a later presence/member response through the actual repository SQL.
integration("Channel details recover each lost read and recheck access (XMATRIX-HUB-AR)", async () => {
  const f = await spaceSecretFixture();
  let fault;
  const { database, clients } = recoveringDatabase(() => fault);
  const spaces = new PostgresSpaceControlRepository(database, "shard-0");
  const read = () => spaces.getChannel({ requestId: crypto.randomUUID(), spaceId: f.ids.space,
    channelId: f.ids.channel, principal: { kind: "user", id: f.ids.owner } });
  const channelRead = /FROM data\.channels c JOIN data\.spaces s/u;
  try {
    for (const mode of ["open", "closed"]) {
      await f.client.query("UPDATE data.channels SET mode=$2 WHERE channel_id=$1", [f.ids.channel, mode]);
      if (mode === "closed") await f.client.query(`INSERT INTO data.channel_access
        (channel_id,space_id,subject_kind,subject_id,grant_version,created_at,updated_at)
        VALUES($1,$2,'user',$3,1,now(),now())`, [f.ids.channel, f.ids.space, f.ids.owner]);
      const expected = await read();
      assert.ok(JSON.stringify(expected.channel.memberPresence).includes(f.ids.instance));
      const memberRead = mode === "open" ? /SELECT user_id FROM data\.space_members/u
        : /SELECT m\.user_id FROM data\.space_members m/u;
      for (const matches of [channelRead, /FROM data\.instances i/u, /SELECT \* FROM \(SELECT i\.instance_id/u, memberRead]) {
        await assertReadRecovery(read, expected, clients, () =>
          fault = { matches, remaining: 1, error: new Error("Query read timeout"), checkouts: [] });
      }
    }
    for (const [error, attempts] of [[new Error("Query read timeout"), 2],
      [Object.assign(new Error("statement timeout"), { code: "57014" }), 1]]) {
      fault = { matches: channelRead, remaining: 3, error, checkouts: [] };
      await assert.rejects(read(), error);
      assert.equal(fault.checkouts.length, attempts, "recovery is bounded and only retries lost responses");
    }
    fault = { matches: channelRead, remaining: 1, error: new Error("Query read timeout"), checkouts: [],
      beforeThrow: () => f.client.query("UPDATE control.space_placement SET placement_epoch=2 WHERE space_id=$1",
        [f.ids.space]) };
    await assert.rejects(read(), /local Space placement fence is stale/u);
    assert.equal(fault.checkouts.length, 1, "recovery refuses the stale placement");
    fault = undefined;
    await f.client.query("UPDATE control.space_placement SET placement_epoch=1 WHERE space_id=$1", [f.ids.space]);
    fault = { matches: channelRead, remaining: 1, error: new Error("Query read timeout"), checkouts: [],
      beforeThrow: () => f.client.query("DELETE FROM data.channel_access WHERE channel_id=$1 AND subject_id=$2",
        [f.ids.channel, f.ids.owner]) };
    await assert.rejects(read(), { code: "channel_not_found" });
    assert.equal(fault.checkouts.length, 1, "replayed SELECT checks the now-revoked grant");
    assert.ok(clients.every(entry => entry.ended));
  } finally {
    await f.client.query("DELETE FROM data.channel_access WHERE channel_id=$1", [f.ids.channel]);
    await f.close();
  }
});

// Generic retry tests cannot catch a billing caller retaining its unnecessary
// BEGIN. Use actual SQL and membership rows, then lose a response at each stage.
integration("billing reads recover lost responses and retain membership checks (XMATRIX-HUB-AM)", async () => {
  const f = await spaceSecretFixture();
  let fault;
  const { database, clients } = recoveringDatabase(() => fault);
  const billing = new PostgresBillingRepository(database, "shard-0");
  const read = () => billing.readSpaceBilling({ requestId: crypto.randomUUID(),
    spaceId: f.ids.space, actorUserId: f.ids.owner });
  try {
    const expected = await read();
    assert.equal(expected.billing.plan, "free");
    assert.deepEqual(expected.billing.seats, { used: 2, limit: 3 });
    for (const matches of [/SELECT role FROM data\.space_members/u, /SELECT COUNT\(\*\) AS count/u]) {
      const before = clients.length;
      fault = { matches, remaining: 1, error: new Error("Query read timeout"), checkouts: [] };
      assert.deepEqual(await read(), expected);
      assert.equal(fault.checkouts.length, 1);
      assert.ok(fault.checkouts[0].ended, "a stalled connection is destroyed");
      assert.ok(clients.indexOf(fault.checkouts[0]) < clients.length - 1);
      assert.ok(clients.slice(before).every(client => client.ended), "request sessions are closed");
    }
    fault = { matches: /SELECT role FROM data\.space_members/u, remaining: 3,
      error: new Error("Query read timeout"), checkouts: [] };
    await assert.rejects(read(), /Query read timeout/u);
    assert.equal(fault.checkouts.length, 2, "two failed reads exhaust recovery");
    await f.client.query("DELETE FROM data.space_members WHERE space_id=$1 AND user_id=$2",
      [f.ids.space, f.ids.owner]);
    fault = { matches: /SELECT role FROM data\.space_members/u, remaining: 1,
      error: new Error("Query read timeout"), checkouts: [] };
    await assert.rejects(read(), { code: "forbidden" });
    assert.equal(fault.checkouts.length, 1, "membership is checked after recovery");
    assert.ok(clients.every(client => client.ended));
  } finally { await f.close(); }
});
