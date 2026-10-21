import assert from "node:assert/strict";
import { Client } from "pg";
import { createAuthorityDatabase, PostgresAutomationRepository, PostgresPageRepository } from "../dist/index.js";
import { integration, connectionString } from "./postgres-database.fixture.mjs";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";

// The existing catalog privacy tests use healthy connections. Exercise the
// repository through the real client and SQL when a read response disappears,
// including a later access check: recovery must still redact private events.
integration("Automation catalogs recover a lost SELECT without losing access checks (XMATRIX-HUB-96)", async () => {
  const f = await spaceSecretFixture();
  const automationId = crypto.randomUUID();
  let fault;
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
        if (fault?.matches.test(text) && fault.remaining > 0) {
          fault.remaining -= 1;
          fault.checkouts.push(entry);
          throw fault.error;
        }
        return result;
      };
      const end = client.end.bind(client);
      client.end = async () => { entry.ended = true; await end(); };
      return client;
    },
  });
  const repository = new PostgresAutomationRepository(database);
  const input = { requestId: crypto.randomUUID(), spaceId: f.ids.space,
    principal: { kind: "user", id: f.ids.owner } };
  try {
    await f.client.query(`INSERT INTO data.space_control_heads(space_id,commit_sequence,updated_at)
      VALUES($1,0,now())`, [f.ids.space]);
    const { page } = await new PostgresPageRepository(database).create({ ...input,
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
    await f.client.query("DELETE FROM data.automations WHERE automation_id=$1", [automationId]);
    for (const table of ["page_revisions", "page_access", "pages"]) {
      await f.client.query(`DELETE FROM data.${table} WHERE space_id=$1`, [f.ids.space]);
    }
    await f.client.query("DELETE FROM control.scoped_control_command_replays WHERE scope_kind='space' AND scope_id=$1", [f.ids.space]);
    await f.client.query("DELETE FROM data.space_control_heads WHERE space_id=$1", [f.ids.space]);
    await f.close();
  }
});
