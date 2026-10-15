import assert from "node:assert/strict";
import { Client } from "pg";
import * as db from "@xmatrix/db";
import * as protocol from "@xmatrix/protocol";

import { connectionString, integration, savepointDatabase } from "../../db/test/postgres-database.fixture.mjs";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

integration("a page summary sends text only to a Machine whose owner currently reads that page", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    const spaceId = `summary-${crypto.randomUUID()}`;
    const owner = { kind: "user", id: `${spaceId}-owner` };
    const member = { kind: "user", id: `${spaceId}-member` };
    const outsider = { kind: "user", id: `${spaceId}-outsider` };
    await client.query(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
      VALUES ('shard-0','active','test',now(),now()) ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO control.space_placement
      (space_id,shard_id,placement_epoch,state,plan_class,created_at,updated_at)
      VALUES ($1,'shard-0',1,'active','test',now(),now())`, [spaceId]);
    await client.query(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,'Summary test',$1,1,'{}',now(),now())`, [spaceId, owner.id]);
    await client.query(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$2,'owner',1,now(),now()),($1,$3,'member',1,now(),now())`, [spaceId, owner.id, member.id]);
    let unavailable = false;
    const database = savepointDatabase(client, text => text, context => {
      if (unavailable && context.operation === "page.read") throw new db.PageControlError("database_unavailable", 503);
    });
    const pages = new db.PostgresPageRepository(database);
    const create = async input => (await pages.create({ requestId: crypto.randomUUID(), spaceId, principal: owner,
      ...input })).page;
    const parent = await create({ title: "Private", accessMode: "restricted", body: "Private ledger\n" });
    const child = await create({ title: "Child", parentPageId: parent.pageId, body: "Inherited private ledger\n" });
    const open = await create({ title: "Open", body: "Public plan\n" });
    let candidates = [member];
    const commands = [];
    const resolve = name => {
      if (name === "@xmatrix/protocol") return protocol;
      if (name === "@xmatrix/db") return { ...db, PostgresMachineControlRepository: class {
        async getDaemon() { return { daemon: { id: "daemon", email: "machine@example.test", status: "online",
          capabilities: [protocol.MACHINE_TEXT_TASK_CAPABILITY] } }; }
      } };
      if (name === "./postgres-authority-fleet") return {
        createPostgresAuthorityDatabase: () => database,
        createPostgresAuthorityFleet: () => ({ directoryDatabase: database }),
      };
      if (name === "./agent-routing-quota-refresh") return { registrationQuotaProbeTargetReader: () => async () =>
        candidates.map(candidate => ({ ownerUserId: candidate.id, machineId: candidate.id, hostId: "host", harness: "claude" })) };
      if (name === "./machines") return { machineDatabase: () => database,
        machineDaemonCommand: async (_env, command) => { commands.push(command); } };
      if (name === "./postgres-authority-http") return { POSTGRES_AUTHORITY_TIMEOUTS: {} };
      if (name === "./postgres-message-database-policy") return { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS: 1000 };
      assert.fail(`unexpected import: ${name}`);
    };
    const machines = await loadCommonJsSourceModule(new URL("../src/text-task-machines.ts", import.meta.url), resolve);
    const { startPageSummary } = await loadCommonJsSourceModule(new URL("../src/page-summary.ts", import.meta.url),
      name => name === "./text-task-machines" ? machines : resolve(name));
    const start = page => startPageSummary({}, { spaceId, pageId: page.pageId });
    for (const page of [parent, child]) {
      assert.equal((await start(page)).started, false, "a member's Machine must not receive a restricted page");
      assert.equal(commands.length, 0);
    }
    candidates = [outsider, member, owner];
    assert.equal((await start(child)).started, true, "an unreadable candidate does not hide an authorized one");
    assert.equal(commands.at(-1).ownerUserId, owner.id);
    assert.equal(commands.at(-1).payload.input, "# Child\n\nInherited private ledger\n");
    candidates = [member];
    await pages.update({ requestId: crypto.randomUUID(), spaceId, pageId: parent.pageId, principal: owner,
      access: [{ userId: member.id, access: "read" }] });
    assert.equal((await start(child)).started, true, "a read grant on the ancestor admits its Machine");
    assert.equal(commands.at(-1).ownerUserId, member.id);
    await pages.update({ requestId: crypto.randomUUID(), spaceId, pageId: parent.pageId, principal: owner, access: [] });
    const issued = commands.length;
    assert.equal((await start(child)).started, false, "revocation is checked again at the next dispatch");
    assert.equal(commands.length, issued);
    assert.equal((await start(open)).started, true, "ordinary open pages still use members' Machines");
    assert.equal(commands.at(-1).payload.input, "# Open\n\nPublic plan\n");
    const sent = commands.length;
    assert.equal((await startPageSummary({}, { spaceId, pageId: open.pageId, triedRevision: open.headRevision })).reason, "tried");
    await pages.recordSummary({ requestId: crypto.randomUUID(), spaceId, pageId: open.pageId,
      revision: open.headRevision, summary: "Ready" });
    assert.equal((await start(open)).reason, "current");
    assert.equal(commands.length, sent, "current and already-tried revisions are not issued again");
    unavailable = true;
    candidates = [member, owner];
    await assert.rejects(start(child), { code: "database_unavailable", status: 503 });
    assert.equal(commands.length, sent, "authority outages never turn into another disclosure attempt");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
