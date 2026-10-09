import assert from "node:assert/strict";
import { connectorDatabase, integration } from "./postgres-database.fixture.mjs";
import { PostgresSentryEventRepository, PostgresAppCredentialRepository, PostgresAppRepository } from "../dist/index.js";

const at = new Date().toISOString();
const issue = { kind: "issue", action: "created", objectId: "42", projectId: "123", projectSlug: "test" };
async function fixture(run) {
  const { client, database, sql } = await connectorDatabase("sentry-event-test");
  const repo = new PostgresSentryEventRepository(database);
  const spaceId = `sentry-event-${crypto.randomUUID()}`;
  const connectionId = `${spaceId}:sentry`;
  const key = { appClientId: `test-${crypto.randomUUID()}`, appUuid: crypto.randomUUID(), installationId: crypto.randomUUID() };
  const generation = crypto.randomUUID();
  const accept = (deliveryDigest = "a".repeat(64), identity = issue) => repo.accept({ ...key, requestId: crypto.randomUUID(), deliveryDigest, identity });
  const claim = () => repo.claim({ ...key, requestId: crypto.randomUUID() });
  const finish = (job, outcome) => repo.finish({ ...job, requestId: crypto.randomUUID(), outcome });
  const current = job => repo.current({ ...job, requestId: crypto.randomUUID() });
  try {
    await sql(`INSERT INTO data.app_connector_connections
      (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
       capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES ($1,$2,1,'sentry','Sentry','configured','oauth','[]','[]','[]','[]','owner',$2,$3,$3)`, [spaceId, connectionId, at]);
    await sql(`INSERT INTO data.app_connector_credentials
      (connection_id,space_id,field_names_json,encrypted_value_json,version,updated_by,created_at,updated_at)
      VALUES ($1,$2,'[]','{}',1,'owner',$3,$3)`, [connectionId, spaceId, at]);
    await sql(`INSERT INTO data.app_connector_oauth_installations
      (connection_id,space_id,provider_id,app_client_id,installation_id,event_scope_id,credential_version,updated_at,grant_generation)
      VALUES ($1,$2,'sentry',$3,$4,$5,1,$6,$7::uuid)`, [connectionId, spaceId, key.appClientId, key.installationId, key.appUuid, at, generation]);
    await run({ sql, database, repo, key, spaceId, connectionId, generation, accept, claim, finish, current });
  } finally {
    await sql("DELETE FROM data.app_sentry_event_receipts WHERE app_client_id=$1", [key.appClientId]);
    await sql("DELETE FROM data.app_sentry_installation_lifecycle WHERE app_client_id=$1", [key.appClientId]);
    for (const table of ["app_source_relations", "channels", "space_deletions", "app_connector_oauth_installations", "app_connector_credentials", "app_connector_connections", "space_members"])
      await sql(`DELETE FROM data.${table} WHERE space_id LIKE $1`, [spaceId+"%"]);
    await database.close?.();
    await client.end();
  }
}
integration("Sentry receipt commits minimal identities and target grants; parallel replays never duplicate work", async () => {
  await fixture(async ({ sql, key, accept, claim, finish }) => {
    const results = await Promise.all([accept(), accept(), accept()]);
    assert.equal(results.filter(row => !row.reused).length, 1);
    assert.equal(results.filter(row => row.reused).length, 2);
    const stored = (await sql("SELECT * FROM data.app_sentry_event_receipts WHERE app_client_id=$1", [key.appClientId])).rows;
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].identity_json, issue);
    await assert.rejects(accept("b".repeat(64), { ...issue, title: "private-user-token" }), /Invalid Sentry/);
    const jobs = await claim();
    assert.equal(jobs.length, 1);
    assert.equal((await claim()).length, 0);
    await finish(jobs[0], "done");
    assert.equal((await accept()).reused, true);
    assert.equal((await claim()).length, 0);
  });
});
integration("Sentry expired lease is recovered; stale completion cannot finish its successor", async () => {
  await fixture(async ({ sql, key, accept, claim, finish, current }) => {
    await accept();
    const [old] = await claim();
    await sql("UPDATE data.app_sentry_event_jobs SET lease_until=now()-interval '1 second' WHERE app_client_id=$1", [key.appClientId]);
    assert.equal(await current(old), null);
    const [newJob] = await claim();
    assert.notEqual(newJob.leaseId, old.leaseId);
    await finish(old, "done");
    assert.deepEqual(await current(newJob), { credentialVersion: 1 });
    await finish(newJob, "retry");
    assert.equal((await claim()).length, 0, "backoff is durable");
    await sql("UPDATE data.app_sentry_event_jobs SET available_at=now()-interval '1 second' WHERE app_client_id=$1", [key.appClientId]);
    assert.equal((await claim()).length, 1);
  });
});
integration("Sentry grant rotation keeps accepted work; replacement, disconnect and uninstall fence it", async () => {
  await fixture(async ({ sql, key, accept, claim, current, connectionId, spaceId, database }) => {
    await accept();
    const [job] = await claim();
    await sql("UPDATE data.app_connector_credentials SET version=2 WHERE connection_id=$1", [connectionId]);
    assert.equal(await current(job), null, "mismatched versions fail closed");
    await sql("UPDATE data.app_connector_oauth_installations SET credential_version=2 WHERE connection_id=$1", [connectionId]);
    assert.deepEqual(await current(job), { credentialVersion: 2 });
    await sql("UPDATE data.app_connector_oauth_installations SET grant_generation=gen_random_uuid() WHERE connection_id=$1", [connectionId]);
    assert.equal(await current(job), null);
    await sql("UPDATE data.app_connector_oauth_installations SET grant_generation=$2::uuid WHERE connection_id=$1", [connectionId, job.grantGeneration]);
    await sql("UPDATE data.app_connector_connections SET status='disconnected' WHERE space_id=$1", [spaceId]);
    assert.equal(await current(job), null);
    await sql("UPDATE data.app_connector_connections SET status='configured' WHERE space_id=$1", [spaceId]);
    await new PostgresAppCredentialRepository(database, "fixture-material").retireSentryInstallation({
      ...key, requestId: crypto.randomUUID(), at: new Date().toISOString(), limit: 50 });
    assert.equal(await current(job), null);
    assert.equal((await accept("b".repeat(64))).retired, true);
  });
});
integration("Sentry bounded retry exhaustion and expired receipt cleanup survive abandoned workers", async () => {
  await fixture(async ({ sql, key, accept, claim, finish }) => {
    await accept();
    for (let attempt = 0; attempt < 8; attempt++) {
      const [job] = await claim();
      assert.ok(job);
      await finish(job, "retry");
      await sql("UPDATE data.app_sentry_event_jobs SET available_at=now()-interval '1 second' WHERE app_client_id=$1", [key.appClientId]);
    }
    assert.equal((await claim()).length, 0);
    assert.equal((await sql("SELECT state,attempts FROM data.app_sentry_event_jobs WHERE app_client_id=$1", [key.appClientId])).rows[0].state, "failed");
    await sql("UPDATE data.app_sentry_event_receipts SET expires_at=now()-interval '1 second' WHERE app_client_id=$1", [key.appClientId]);
    assert.equal((await claim()).length, 0);
    assert.equal((await sql("SELECT * FROM data.app_sentry_event_jobs WHERE app_client_id=$1", [key.appClientId])).rows.length, 0);
    assert.equal((await accept()).reused, false);
  });
});
integration("Sentry receipt fails closed without a current generation and rolls back backlog overflow", async () => {
  await fixture(async ({ sql, key, accept, connectionId, generation }) => {
    await sql("UPDATE data.app_connector_oauth_installations SET grant_generation=NULL WHERE connection_id=$1", [connectionId]);
    await assert.rejects(accept(), /bindings are unavailable/);
    assert.equal((await sql("SELECT * FROM data.app_sentry_event_receipts WHERE app_client_id=$1", [key.appClientId])).rows.length, 0);
    await sql("UPDATE data.app_connector_oauth_installations SET grant_generation=$2::uuid WHERE connection_id=$1", [connectionId, generation]);
    await accept();
    const duplicate = (await sql("SELECT * FROM data.app_sentry_event_jobs WHERE app_client_id=$1", [key.appClientId])).rows[0];
    await sql(`INSERT INTO data.app_sentry_event_jobs
      SELECT app_client_id,app_uuid,installation_uuid,delivery_digest,connection_id||'-'||n,space_id,grant_generation,
        state,attempts,available_at,lease_id,lease_until,updated_at FROM data.app_sentry_event_jobs CROSS JOIN generate_series(1,999) n
      WHERE app_client_id=$1`, [key.appClientId]);
    assert.equal(duplicate.state, "pending");
    await assert.rejects(accept("b".repeat(64)), /backlog is full/);
    assert.equal((await sql("SELECT * FROM data.app_sentry_event_receipts WHERE app_client_id=$1", [key.appClientId])).rows.length, 1);
  });
});
integration("Sentry current Space deletion and grant-scoped subscriptions fail closed without truncation", async () => {
  await fixture(async ({ sql, key, accept, claim, current, database, spaceId, connectionId, generation }) => {
    await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      SELECT $1||':channel-'||n,$1,'test-'||n,'test-'||n,'open',$1||':channel-'||n,1,$2,$2 FROM generate_series(1,2) n`, [spaceId, at]);
    await sql(`INSERT INTO data.app_source_relations (relation_id,connection_id,space_id,channel_id,source_kind,
      source_ref,features_json,version,created_by,created_at,updated_at)
      SELECT $1||':relation-'||n,$2,$1,$1||':channel-'||n,'repository','sentry:test','["issue.created"]',1,'owner',$3,$3
      FROM generate_series(1,2) n`, [spaceId, connectionId, at]);
    // A route posts as its subscriber, who must still be able to post there.
    await sql(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,'owner','owner',1,$2,$2)`, [spaceId, at]);
    const apps = new PostgresAppRepository(database);
    const binding = { providerId: "sentry", appClientId: key.appClientId, installationId: key.installationId,
      credentialVersion: 1, grantGeneration: generation };
    const routes = (oauthBinding = binding, limit = 2) => apps.connectorEventRoutes({ requestId: crypto.randomUUID(), connectionId,
      sourceRef: "sentry:test", limit, oauthBinding });
    assert.equal((await routes()).length, 2);
    await assert.rejects(routes(binding, 1), /exceeds its bound/);
    await assert.rejects(routes({ ...binding, grantGeneration: undefined }), /generation and version/);
    assert.deepEqual(await routes({ ...binding, grantGeneration: crypto.randomUUID() }), []);
    await accept();
    const [job] = await claim();
    await sql(`INSERT INTO data.space_deletions (space_id,space_name,owner_user_id,requested_at,purge_after,state,
      members_json,automations_json,version,updated_at) VALUES ($1,'test','owner',now(),now()+interval '7 days','scheduled','[]','[]',1,now())`, [spaceId]);
    assert.equal(await current(job), null);
    assert.deepEqual(await routes(), []);
    await assert.rejects(accept("b".repeat(64)), /bindings are unavailable/);
  });
});
integration("Sentry installation fanout overflow rolls back the entire new receipt", async () => {
  await fixture(async ({ sql, key, accept, spaceId, connectionId }) => {
    for (const table of ["app_connector_connections", "app_connector_credentials", "app_connector_oauth_installations"]) {
      await sql(`INSERT INTO data.${table} SELECT (jsonb_populate_record(NULL::data.${table},to_jsonb(c)||
        jsonb_build_object('connection_id',$1||'-'||n||':sentry','space_id',$1||'-'||n,'search_rank_sequence',$2||'-rank-'||n))).*
        FROM data.${table} c CROSS JOIN generate_series(1,50) n WHERE c.connection_id=$2`, [spaceId, connectionId]);
    }
    await assert.rejects(accept(), /bindings are unavailable/);
    assert.equal((await sql("SELECT * FROM data.app_sentry_event_receipts WHERE app_client_id=$1", [key.appClientId])).rows.length, 0);
    assert.equal((await sql("SELECT count(*)::int n FROM data.app_connector_oauth_installations WHERE app_client_id=$1", [key.appClientId])).rows[0].n, 51);
  });
});
integration("Sentry concurrent retirement and admission cannot leave a live accepted grant", async () => {
  await fixture(async ({ sql, database, key, accept, claim, current }) => {
    const retirement = () => new PostgresAppCredentialRepository(database, "fixture-material").retireSentryInstallation({
      ...key, requestId: crypto.randomUUID(), at: new Date().toISOString(), limit: 50 });
    const result = await Promise.all([accept(), retirement()]);
    assert.equal(result[0].accepted, true);
    const jobs = await claim();
    for (const job of jobs) assert.equal(await current(job), null);
    assert.equal((await sql("SELECT count(*)::int n FROM data.app_connector_oauth_installations WHERE app_client_id=$1", [key.appClientId])).rows[0].n, 0);
  });
});
integration("Sentry overlapping recovery wakes never exceed eight active leases per app", async () => {
  await fixture(async ({ accept, claim }) => {
    for (let n = 1; n <= 12; n++) await accept(n.toString(16).padStart(64, "0"));
    const groups = await Promise.all([claim(), claim(), claim()]);
    assert.equal(groups.flat().length, 8);
    assert.equal(new Set(groups.flat().map(job => job.leaseId)).size, 8);
    assert.equal((await claim()).length, 0);
  });
});
