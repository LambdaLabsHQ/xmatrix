import assert from "node:assert/strict";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import { readActivationReport } from "../scripts/activation-report.mjs";

integration("activation SQL excludes automation and xMatrix notices, requires actual replies and ordered Pages, and refuses incomplete shards", async () => {
  const f = await isolatedPostgres("activation", { migrate: false, shard: false, runtimeRole: false });
  try {
    // Minimal input records exercise the report against real PostgreSQL. This
    // does not implement query semantics in a mock.
    await f.run(`CREATE SCHEMA control; CREATE SCHEMA data;
      CREATE TABLE control.auth_users(id text,created_at timestamptz);
      CREATE TABLE control.space_placement(space_id text,shard_id text,state text);
      CREATE TABLE control.postgres_local_identity(shard_id text);
      CREATE TABLE data.space_members(space_id text,user_id text);
      CREATE TABLE data.messages(author_id text,space_id text,message_id text,channel_id text,
        sent_at timestamptz,author_kind text,deleted_at timestamptz,recalled_at timestamptz);
      CREATE TABLE data.agent_launches(space_id text,channel_id text,trigger_id text,first_reply_at timestamptz);
      CREATE TABLE data.pages(space_id text,created_by_user_id text,created_at timestamptz);
      INSERT INTO control.postgres_local_identity VALUES('shard-0');
      INSERT INTO control.space_placement VALUES('s','shard-0','active');
      INSERT INTO control.auth_users VALUES('person','2026-09-01'),('scheduled','2026-09-01'),
        ('connected','2026-09-01'),('recalled','2026-09-01'),('welcomed','2026-09-01'),('old','2026-08-01');
      INSERT INTO data.messages VALUES
        ('person','s','m','c','2026-09-02','user',NULL,NULL),
        ('person','s','m2','c','2026-09-09','user',NULL,NULL),
        ('scheduled','s','scheduled-message:a','c','2026-09-02','user',NULL,NULL),
        ('connected','s','m3','c','2026-09-02','user',NULL,NULL),
        ('recalled','s','m4','c','2026-09-02','user',NULL,'2026-09-03'),
        ('welcomed','s','system:welcome:c:bring-agents','c','2026-09-02','user',NULL,NULL),
        ('welcomed','s','system:machine-run-failure:a','c','2026-09-09','user',NULL,NULL);
      INSERT INTO data.agent_launches VALUES
        ('s','c','m','2026-09-02T01:00Z'),('s','c','m3',NULL),
        ('s','c','scheduled-message:a','2026-09-02T01:00Z');
      INSERT INTO data.pages VALUES('s','person','2026-09-03'),('s','connected','2026-09-01');`);
    const config = { excludedUserIds: [], externalUserIds: ["person"], internalSpaceIds: [], shardUrlEnvs: [] };
    const env = { POSTGRES_RUNTIME_DATABASE_URL: f.url.toString() };
    const read = () => readActivationReport(config, "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", env);
    const result = await read();
    assert.equal(result.coveredShards, 1);
    assert.deepEqual(result.cohorts.confirmedExternal, { registrations: 1, humanMessage: 1,
      firstReply: 1, pageCreated: 1, activatedWithPage: 1, weekTwoEligible: 1, weekTwoActive: 1 });
    assert.equal(result.cohorts.unclassified.registrations, 4);
    assert.equal(result.cohorts.unclassified.humanMessage, 1);
    assert.equal(result.cohorts.unclassified.firstReply, 0);
    assert.equal(result.cohorts.unclassified.activatedWithPage, 0);
    await f.run("UPDATE data.pages SET created_at='2026-09-01' WHERE created_by_user_id='person'");
    assert.equal((await read()).cohorts.confirmedExternal.activatedWithPage, 0);
    await f.run("INSERT INTO control.space_placement VALUES('other','missing-shard','active')");
    await assert.rejects(read(), /Incomplete shard/);
    await f.run("UPDATE control.space_placement SET state='moving' WHERE space_id='other'");
    await assert.rejects(read(), /not stable/);
    // Counts only, including failure cases: the report never mutates records.
    assert.equal((await f.run("SELECT count(*) n FROM control.auth_users"))[0].n, "5");
  } finally { await f.close(); }
});
