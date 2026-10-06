import { postgresDatabase as database, connectionString, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";

import { Client } from "pg";

import { PostgresTraceAccessRepository } from "../dist/trace-access-control.js";



integration("a Channel reader sees an Agent trace without a request grant", async () => {
  assert.ok(connectionString, "XMATRIX_TEST_POSTGRES_URL is required");
  const id = `trace-reader-${crypto.randomUUID()}`;
  const space = `${id}-space`;
  const otherSpace = `${id}-other`;
  const owner = `${id}-owner`;
  const reader = `${id}-reader`;
  const outsider = `${id}-outsider`;
  const open = `${id}-open`;
  const closed = `${id}-closed`;
  const foreign = `${id}-foreign`;
  const instanceId = `${id}-instance`;
  const client = new Client({ connectionString, application_name: id });
  await client.connect();
  try {
    for (const spaceId of [space, otherSpace]) {
      await client.query(`INSERT INTO data.spaces
        (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
        VALUES ($1,$2,'Trace reader test',$1,1,'{}',now(),now())`, [spaceId, owner]);
    }
    for (const [spaceId, userId, role] of [[space, owner, "owner"], [space, reader, "member"],
      [otherSpace, reader, "owner"]]) {
      await client.query(`INSERT INTO data.space_members
        (space_id,user_id,role,version,created_at,updated_at)
        VALUES ($1,$2,$3,1,now(),now())`, [spaceId, userId, role]);
    }
    for (const [channelId, spaceId, mode] of [[open, space, "open"], [closed, space, "closed"],
      [foreign, otherSpace, "open"]]) {
      await client.query(`INSERT INTO data.channels
        (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
         metadata_json,created_at,updated_at)
        VALUES ($1,$2,$1,$1,$3,$1,1,'{}',now(),now())`, [channelId, spaceId, mode]);
    }
    await client.query(`INSERT INTO data.runs
      (run_id,owner_user_id,channel_id,status,version,created_at,updated_at)
      VALUES ($1,$2,$3,'running',1,now(),now())`, [`${id}-run`, owner, open]);
    await client.query(`INSERT INTO data.instances
      (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
      VALUES ($1,$2,$3,1,'online',1,now(),now())`, [instanceId, `${id}-run`, open]);

    const repository = new PostgresTraceAccessRepository(database(client));
    const route = await repository.authorize({ instanceId, principal: { kind: "user", id: reader } });
    assert.deepEqual(route, { allowed: true,
      traceRoute: { instanceId, channelId: open, terminal: false } });
    assert.equal((await repository.authorize({ instanceId,
      principal: { kind: "user", id: outsider } })).allowed, false);

    const batch = await repository.authorizeBatch({ instanceId, checks: [
      { userId: owner, channelId: closed },
      { userId: reader, channelId: open },
      { userId: reader, channelId: closed },
      { userId: reader, channelId: foreign },
      { userId: outsider, channelId: open },
    ] });
    assert.deepEqual(batch.decisions.map((decision) => decision.allowed),
      [true, true, false, false, false],
      "owner always; reader only where they read the Channel and the owner shares its Space");

    await client.query("UPDATE data.runs SET status='finished' WHERE run_id=$1", [`${id}-run`]);
    const ended = await repository.authorizeBatch({ instanceId,
      checks: [{ userId: reader, channelId: open }] });
    assert.equal(ended.decisions[0].allowed, false, "a terminal Run has no live trace to read");
  } finally {
    await client.query("DELETE FROM data.instances WHERE instance_id=$1", [instanceId]).catch(() => {});
    await client.query("DELETE FROM data.runs WHERE run_id=$1", [`${id}-run`]).catch(() => {});
    for (const table of ["channels", "space_members", "spaces"]) {
      await client.query(`DELETE FROM data.${table} WHERE space_id=ANY($1)`, [[space, otherSpace]])
        .catch(() => {});
    }
    await client.end();
  }
});
