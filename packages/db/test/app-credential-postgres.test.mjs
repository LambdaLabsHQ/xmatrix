import { connectorDatabase, integration } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";

import {
  AppControlError,
  PostgresAppActionPolicyRepository,
  PostgresAppCredentialRepository,
  PostgresAppRepository,
  PostgresSpaceControlRepository,
} from "../dist/index.js";

const at = "2026-10-02T00:00:00.000Z";
const material = "test-secret-catalog-key";

async function addConnection(sql, space, providerId, providerName = providerId) {
  await sql(`INSERT INTO data.app_connector_connections
    (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
     capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
    VALUES ($2,$2||':'||$3,1,$3,$4,'configured','api-token','[]','[]','[]','[]','owner',
      $2||':rank-'||$3,$1,$1)`, [at, space, providerId, providerName]);
}

/* Other PostgreSQL test files share this database and run concurrently, so
   each test owns a fresh Space id and removes only its own rows. */
async function withDatabase(run) {
  const { client, database, sql } = await connectorDatabase("app-credential-test");
  const space = `credential-space-${crypto.randomUUID()}`;
  const cleanup = async () => {
    for (const table of ["app_connector_action_policies", "app_connector_credentials", "app_source_relations",
      "app_connector_connections",
      "channels", "space_members"]) await sql(`DELETE FROM data.${table} WHERE space_id=$1`, [space]);
  };
  try {
    await sql(`INSERT INTO data.space_members (space_id,user_id,role,version,created_at,updated_at) VALUES
      ($2,'owner','owner',1,$1,$1),($2,'member','member',1,$1,$1)`, [at, space]);
    await addConnection(sql, space, "webhook", "Webhook");
    await run({ sql, database, space });
  } finally {
    await cleanup();
    await database.close?.();
    await client.end();
  }
}

const policy = { allowed: ["ingressKey", "signingSecret", "apiToken"] };

integration("connector credentials are encrypted, admin-written, and readable only as generated fields", async () => {
  await withDatabase(async ({ sql, database, space }) => {
    const credentials = new PostgresAppCredentialRepository(database, material);
    const written = await credentials.put({ requestId: "put-1", spaceId: space, providerId: "webhook",
      actorUserId: "owner", fields: { ingressKey: "key-1", apiToken: "tok-secret" }, policy, at });
    assert.deepEqual(written, { connectionId: `${space}:webhook`, credentialFields: ["apiToken", "ingressKey"] });

    const stored = (await sql("SELECT * FROM data.app_connector_credentials WHERE space_id=$1", [space])).rows[0];
    assert.doesNotMatch(JSON.stringify(stored), /tok-secret|key-1/u, "values are never stored in the clear");
    assert.deepEqual(stored.field_names_json, ["apiToken", "ingressKey"]);

    assert.deepEqual(await credentials.readGenerated({ requestId: "read-1", spaceId: space,
      providerId: "webhook", actorUserId: "owner", generated: ["ingressKey"] }), { ingressKey: "key-1" });
    await assert.rejects(credentials.readGenerated({ requestId: "read-2", spaceId: space,
      providerId: "webhook", actorUserId: "member", generated: ["ingressKey"] }),
    (error) => error instanceof AppControlError && error.status === 404);
    await assert.rejects(credentials.put({ requestId: "put-2", spaceId: space, providerId: "webhook",
      actorUserId: "member", fields: { apiToken: "x" }, policy, at }),
    (error) => error instanceof AppControlError && error.status === 404);
    await assert.rejects(credentials.put({ requestId: "put-3", spaceId: space, providerId: "webhook",
      actorUserId: "owner", fields: { unknownField: "x" }, policy, at }),
    (error) => error instanceof AppControlError && error.status === 400);

    const merged = await credentials.put({ requestId: "put-4", spaceId: space, providerId: "webhook",
      actorUserId: "owner", fields: { apiToken: null, signingSecret: "sig" }, policy, at });
    assert.deepEqual(merged.credentialFields, ["ingressKey", "signingSecret"]);
    const resolved = await credentials.resolve({ requestId: "resolve-1", spaceId: space, providerId: "webhook" });
    assert.deepEqual(resolved.values, { ingressKey: "key-1", signingSecret: "sig" });
    assert.equal(resolved.status, "configured");
    assert.equal(resolved.createdBy, "owner");

    await assert.rejects(new PostgresAppCredentialRepository(database, "another-key")
      .resolve({ requestId: "resolve-2", spaceId: space, providerId: "webhook" }),
    /integrity check failed/u, "a different key cannot decrypt");

    await sql("UPDATE data.app_connector_credentials SET version=version+1 WHERE space_id=$1", [space]);
    await assert.rejects(credentials.resolve({ requestId: "resolve-3", spaceId: space, providerId: "webhook" }),
      /integrity check failed/u, "the envelope is bound to its version");
  });
});

integration("a connection's member read shows credential names, and deleting it deletes its credentials", async () => {
  await withDatabase(async ({ sql, database, space }) => {
    const credentials = new PostgresAppCredentialRepository(database, material);
    const apps = new PostgresAppRepository(database);
    await credentials.put({ requestId: "put-1", spaceId: space, providerId: "webhook",
      actorUserId: "owner", fields: { ingressKey: "key-1" }, policy, at });
    const { connection } = await apps.getConnection({ requestId: "get-1", connectionId: `${space}:webhook`,
      actorUserId: "member" });
    assert.deepEqual(connection.credentialFields, ["ingressKey"]);
    assert.doesNotMatch(JSON.stringify(connection), /key-1/u);

    await apps.command({ commandId: `delete-${space}`, spaceId: space, providerId: "webhook",
      principal: { kind: "user", id: "owner" } }, "delete");
    assert.equal((await sql("SELECT count(*)::int AS n FROM data.app_connector_credentials WHERE space_id=$1", [space])).rows[0].n, 0);
  });
});

integration("event routes are the configured connection's Channels subscribed to the source", async () => {
  await withDatabase(async ({ sql, database, space }) => {
    const apps = new PostgresAppRepository(database);
    await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
      created_at,updated_at) VALUES ($2||':a',$2,'a','a','open',$2||':rank-a',1,$1,$1),
      ($2||':b',$2,'b','b','open',$2||':rank-b',1,$1,$1)`, [at, space]);
    await sql(`INSERT INTO data.app_source_relations (relation_id,connection_id,space_id,channel_id,source_kind,
      source_ref,features_json,version,created_by,created_at,updated_at) VALUES
      ($2||':r1',$2||':webhook',$2,$2||':a','repository','webhook:deploys','["delivery"]',1,'owner',$1,$1),
      ($2||':r2',$2||':webhook',$2,$2||':b','repository','webhook:other','["delivery"]',1,'member',$1,$1)`,
    [at, space]);
    assert.deepEqual(await apps.connectorEventRoutes({ requestId: "routes-1", connectionId: `${space}:webhook`,
      sourceRef: "Webhook:Deploys", limit: 10 }), [{ spaceId: space, channelId: `${space}:a`,
      authorityRootUserId: "owner", features: ["delivery"] }]);
    await sql("UPDATE data.app_connector_connections SET status='disconnected' WHERE space_id=$1", [space]);
    assert.deepEqual(await apps.connectorEventRoutes({ requestId: "routes-2", connectionId: `${space}:webhook`,
      sourceRef: "webhook:deploys", limit: 10 }), []);
  });
});

integration("a Channel's connection list reads subscriptions and credentials in batches, not per connection", async () => {
  await withDatabase(async ({ sql, database, space }) => {
    /* XMATRIX-HUB-4S: each connection's details were read one query at a time on
       one transaction, and the 11th queued read hit the client read timeout. */
    const providers = Array.from({ length: 24 }, (_, index) => `p${String(index).padStart(2, "0")}`);
    for (const provider of providers) await addConnection(sql, space, provider);
    for (const name of ["a", "b"]) await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,
      search_rank_sequence,version,created_at,updated_at) VALUES ($2||':'||$3,$2,$3,$3,'open',$2||':rank-'||$3,1,$1,$1)`,
    [at, space, name]);
    await sql(`INSERT INTO data.app_source_relations (relation_id,connection_id,space_id,channel_id,source_kind,
      source_ref,features_json,version,created_by,created_at,updated_at) VALUES
      ($2||':r1',$2||':p00',$2,$2||':a','repository','p00:two','["delivery"]',1,'owner',$1,$1),
      ($2||':r2',$2||':p00',$2,$2||':a','repository','p00:one','["delivery"]',1,'owner',$1,$1),
      ($2||':r3',$2||':p00',$2,$2||':b','repository','p00:other','["delivery"]',1,'owner',$1,$1),
      ($2||':r4',$2||':p23',$2,$2||':a','issue','p23:late','["delivery"]',1,'owner',$1,$1)`, [at, space]);
    await new PostgresAppCredentialRepository(database, material).put({ requestId: "put-batch", spaceId: space,
      providerId: "webhook", actorUserId: "owner", fields: { apiToken: "tok" }, policy, at });

    let queries = 0;
    const counted = { cacheMode: database.cacheMode, transaction: (options, run) => database.transaction(options,
      (tx) => run(new Proxy(tx, { get: (target, key) => key === "query"
        ? (...args) => { queries += 1; return target.query(...args); }
        : typeof target[key] === "function" ? target[key].bind(target) : target[key] }))) };
    const { connections, cursor } = await new PostgresAppRepository(counted).listConnections({
      requestId: "list-batch", spaceId: space, actorUserId: "owner", channelId: `${space}:a`, limit: 50 });

    assert.equal(cursor, null);
    assert.equal(connections.length, 25);
    const byProvider = new Map(connections.map((entry) => [entry.providerId, entry]));
    assert.deepEqual(byProvider.get("p00").channelState.subscriptions.map(({ kind, source }) => ({ kind, source })),
      [{ kind: "repository", source: "p00:one" }, { kind: "repository", source: "p00:two" }]);
    assert.equal(byProvider.get("p00").channelState.bound, true);
    assert.deepEqual(byProvider.get("p23").channelState.subscriptions.map(({ source }) => source), ["p23:late"],
      "a connection past the first relation batch keeps its subscriptions");
    assert.equal(byProvider.get("p01").channelState.bound, false);
    assert.deepEqual(byProvider.get("webhook").credentialFields, ["apiToken"]);
    assert.deepEqual(byProvider.get("p00").credentialFields, []);
    assert.ok(queries <= 10, `listing 25 connections took ${queries} queries`);
  });
});

integration("action policy is admin-written per Channel, read at execution, and removed with its connection", async () => {
  await withDatabase(async ({ sql, database, space }) => {
    const policies = new PostgresAppActionPolicyRepository(database);
    const apps = new PostgresAppRepository(database);
    await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
      created_at,updated_at) VALUES ($2||':a',$2,'a','a','open',$2||':rank-a',1,$1,$1)`, [at, space]);
    const base = { spaceId: space, providerId: "webhook", channelId: `${space}:a`, actionId: "Post", at };
    const read = () => policies.mode({ requestId: crypto.randomUUID(), connectionId: `${space}:webhook`,
      channelId: `${space}:a`, actionId: "post" });
    assert.equal(await read(), null);
    await policies.set({ ...base, requestId: "p1", mode: "allow", actorUserId: "owner" });
    assert.equal(await read(), "allow");
    await policies.set({ ...base, requestId: "p2", mode: "deny", actorUserId: "owner" });
    assert.equal(await read(), "deny");
    await assert.rejects(policies.set({ ...base, requestId: "p3", mode: "allow", actorUserId: "member" }),
      (error) => error instanceof AppControlError && error.status === 404);
    await assert.rejects(policies.set({ ...base, requestId: "p4", channelId: "elsewhere", mode: "allow", actorUserId: "owner" }),
      (error) => error instanceof AppControlError && error.code === "channel_not_found");
    assert.deepEqual((await policies.list({ requestId: "l1", spaceId: space, providerId: "webhook", actorUserId: "member" }))
      .map(({ channelId, actionId, mode }) => ({ channelId, actionId, mode })),
    [{ channelId: `${space}:a`, actionId: "post", mode: "deny" }], "members see the Channel overrides");
    await assert.rejects(policies.list({ requestId: "l2", spaceId: space, providerId: "webhook", actorUserId: "stranger" }),
      (error) => error instanceof AppControlError && error.status === 404);
    await policies.set({ ...base, requestId: "p5", mode: null, actorUserId: "owner" });
    assert.equal(await read(), null);
    await policies.set({ ...base, requestId: "p6", mode: "allow", actorUserId: "owner" });
    await apps.command({ commandId: `delete-policy-${space}`, spaceId: space, providerId: "webhook",
      principal: { kind: "user", id: "owner" } }, "delete");
    assert.equal((await sql("SELECT count(*)::int AS n FROM data.app_connector_action_policies WHERE space_id=$1",
      [space])).rows[0].n, 0);
  });
});

async function useSlack(sql, space) {
  await sql(`UPDATE data.app_connector_connections SET connection_id=$1||':slack',provider_id='slack',
    provider_name='Slack',auth_mode='oauth' WHERE space_id=$1`, [space]);
}
const oauthPolicy = { allowed: ['botToken', 'ingressKey', 'signingSecret'] };
const oauthInput = (space, installationId = 'T1') => ({ requestId: crypto.randomUUID(), spaceId: space,
  providerId: 'slack', actorUserId: 'owner', fields: { botToken: `fixture-${installationId}` },
  policy: oauthPolicy, oauthInstallation: { appClientId: 'app-1', installationId },
  initialize: { ingressKey: `fixture-key-${installationId}` }, at });
const readOAuth = (apps, extra = {}) => apps.oauthEventConnections({ requestId: crypto.randomUUID(),
  providerId: 'slack', appClientId: 'app-1', installationId: 'T1', limit: 50, ...extra });

async function useVercel(sql, space) {
  await sql(`UPDATE data.app_connector_connections SET connection_id=$1||':vercel',provider_id='vercel',
    provider_name='Vercel',auth_mode='oauth' WHERE space_id=$1`, [space]);
}
const vercelInput = (space, id = 'icfg_A', scope = 'team_A') => ({ requestId: crypto.randomUUID(), spaceId: space,
  providerId: 'vercel', actorUserId: 'owner', fields: { oauthToken: `fixture-${id}`, oauthConfigurationId: id,
    oauthAppClientId: 'oac_app', oauthTeamId: scope }, at,
  policy: { allowed: ['oauthToken', 'oauthConfigurationId', 'oauthAppClientId', 'oauthTeamId'] },
  oauthInstallation: { appClientId: 'oac_app', installationId: id, eventScopeId: scope } });
const vercelConnections = (apps, scope = 'team_A', limit = 50) => apps.vercelEventConnections({
  requestId: crypto.randomUUID(), appClientId: 'oac_app', eventScopeId: scope, limit });

integration('Vercel configuration and account bindings cannot be guessed; route reads retain the original credential version', async () => {
  await withDatabase(async ({ sql, database, space }) => {
    await useVercel(sql, space);
    const credentials = new PostgresAppCredentialRepository(database, material);
    const apps = new PostgresAppRepository(database);
    const initial = vercelInput(space);
    await assert.rejects(credentials.put({ ...initial, actorUserId: 'member' }), /Space not found/);
    await assert.rejects(credentials.put({ ...initial, oauthInstallation: { appClientId: 'oac_app', installationId: 'icfg_A' } }), /Invalid OAuth/);
    await credentials.put({ ...initial, oauthInstallation: undefined });
    await sql(`UPDATE data.app_connector_connections SET metadata_json='{"eventScopeId":"team_A","installationId":"icfg_A"}'
      WHERE space_id=$1`, [space]);
    assert.deepEqual(await vercelConnections(apps), []);
    await credentials.put(initial);
    const [snapshot] = await vercelConnections(apps);
    assert.equal(snapshot.installationId, 'icfg_A');
    assert.equal(snapshot.credentialVersion, 2);
    assert.deepEqual(await vercelConnections(apps, 'team_B'), []);
    await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
      created_at,updated_at) VALUES ($2||':a',$2,'a','a','open',$2||':rank-a',1,$1,$1)`, [at, space]);
    await sql(`INSERT INTO data.app_source_relations (relation_id,connection_id,space_id,channel_id,source_kind,
      source_ref,features_json,version,created_by,created_at,updated_at) VALUES
      ($2||':r1',$2||':vercel',$2,$2||':a','repository','vercel:test-app','["succeeded"]',1,'owner',$1,$1)`, [at, space]);
    const binding = { providerId: 'vercel', appClientId: 'oac_app', installationId: snapshot.installationId,
      credentialVersion: snapshot.credentialVersion };
    const routes = oauthBinding => apps.connectorEventRoutes({ requestId: crypto.randomUUID(), connectionId: snapshot.connectionId,
      sourceRef: 'vercel:test-app', limit: 10, oauthBinding });
    assert.equal((await routes(binding)).length, 1);
    await assert.rejects(routes({ ...binding, credentialVersion: undefined }), /credential version/);
    await credentials.put(initial); // Same installation, changed grant version.
    assert.deepEqual(await routes(binding), [], 'a same-scope reauthorization must invalidate the in-flight snapshot');
    await credentials.put({ ...initial, fields: { oauthToken: 'manual-edit' }, oauthInstallation: undefined });
    assert.deepEqual(await vercelConnections(apps), [], 'human credential edits never become an OAuth binding');
  });
});

integration('signed Vercel retirement is bounded, exact, idempotent and preserves private credential evidence', async () => {
  await withDatabase(async ({ sql, database, space }) => {
    await withDatabase(async ({ sql: otherSql, database: otherDatabase, space: other }) => {
      await useVercel(sql, space); await useVercel(otherSql, other);
      const credentials = new PostgresAppCredentialRepository(database, material);
      const otherCredentials = new PostgresAppCredentialRepository(otherDatabase, material);
      const apps = new PostgresAppRepository(database);
      await credentials.put(vercelInput(space)); await otherCredentials.put(vercelInput(other));
      const retire = overrides => apps.retireVercelInstallation({ requestId: crypto.randomUUID(), appClientId: 'oac_app',
        installationId: 'icfg_A', eventScopeId: 'team_A', at, limit: 50, ...overrides });
      assert.equal(await retire({ installationId: 'icfg_old' }), 0);
      assert.equal(await retire({ eventScopeId: 'team_B' }), 0);
      assert.equal(await retire({ appClientId: 'oac_other' }), 0);
      await assert.rejects(retire({ limit: 1 }), /exceeds its bound/);
      assert.equal((await vercelConnections(apps)).length, 2, 'overflow rolls back before any retirement');
      const before = await credentials.resolve({ requestId: crypto.randomUUID(), spaceId: space, providerId: 'vercel' });
      const connectionVersion = Number((await sql('SELECT version FROM data.app_connector_connections WHERE space_id=$1', [space])).rows[0].version);
      await otherCredentials.put(vercelInput(other, 'icfg_B', 'team_B'));
      assert.equal(await retire({}), 1);
      assert.equal(await retire({}), 0);
      const after = await credentials.resolve({ requestId: crypto.randomUUID(), spaceId: space, providerId: 'vercel' });
      assert.equal(after.status, 'disconnected');
      assert.deepEqual(after.values, before.values, 'retirement does not silently delete manually supplied or audit evidence');
      assert.equal(Number((await sql('SELECT version FROM data.app_connector_connections WHERE space_id=$1', [space])).rows[0].version),
        connectionVersion + 1, 'the connection lifecycle has a new canonical version');
      assert.equal((await vercelConnections(apps, 'team_B')).length, 1, 'the replacement grant remains current');
      assert.deepEqual(await vercelConnections(apps), []);
    });
  });
});

integration('OAuth installation binding is atomic with credentials and invalidated by human edits or deletion', async () => {
  await withDatabase(async ({ sql, database, space }) => {
    await useSlack(sql, space);
    const credentials = new PostgresAppCredentialRepository(database, material);
    const apps = new PostgresAppRepository(database);
    await assert.rejects(credentials.put({ ...oauthInput(space), actorUserId: 'member' }), /Space not found/);
    assert.deepEqual(await readOAuth(apps), []);
    await credentials.put(oauthInput(space));
    const expected = [{ connectionId: `${space}:slack`, spaceId: space }];
    assert.deepEqual(await readOAuth(apps), expected);
    const read = () => credentials.resolve({ requestId: crypto.randomUUID(), spaceId: space, providerId: 'slack' });
    const before = await read();
    await assert.rejects(credentials.put({ ...oauthInput(space, 'T2'), fields: { invalidField: 'bad' } }), /Unsupported/);
    assert.deepEqual(await readOAuth(apps), expected, 'a failed write never leaves a mismatched binding');
    await credentials.put({ ...oauthInput(space), oauthInstallation: undefined, initialize: undefined, asHub: true,
      expectedVersion: before.version, actorUserId: 'hub:oauth-refresh', fields: { botToken: 'refreshed' } });
    assert.deepEqual(await readOAuth(apps), expected, 'server refresh carries the binding onto its new credential version');
    await assert.rejects(credentials.put({ ...oauthInput(space), oauthInstallation: undefined, asHub: true,
      expectedVersion: before.version, fields: { botToken: 'stale-refresh' } }), /changed during refresh/);
    await credentials.put(oauthInput(space, 'T2'));
    assert.deepEqual(await readOAuth(apps), []);
    assert.equal((await read()).values.ingressKey, before.values.ingressKey, 'reauth preserves existing ingress URLs');
    await assert.rejects(credentials.put({ ...oauthInput(space), oauthInstallation: undefined, asHub: true,
      expectedVersion: before.version, fields: { botToken: 'old-workspace-token' } }), /changed during refresh/);
    assert.equal((await read()).values.botToken, 'fixture-T2');
    await credentials.put({ ...oauthInput(space), oauthInstallation: undefined, initialize: undefined,
      fields: { signingSecret: 'admin-signature-edit' } });
    assert.deepEqual(await readOAuth(apps, { installationId: 'T2' }), [], 'manual credentials require new grant evidence');
    await credentials.put(oauthInput(space));
    await apps.command({ commandId: `delete-oauth-${space}`, spaceId: space, providerId: 'slack',
      principal: { kind: 'user', id: 'owner' } }, 'delete');
    assert.equal((await sql('SELECT count(*)::int AS n FROM data.app_connector_oauth_installations WHERE space_id=$1', [space])).rows[0].n, 0);
  });
});

async function withSlackDatabasePair(run) {
  await withDatabase(async current => {
    await withDatabase(async other => {
      await useSlack(current.sql, current.space);
      await useSlack(other.sql, other.space);
      await run(current, other);
    });
  });
}

integration('OAuth routing scopes by provider, application, workspace and current credential evidence, with bounded fanout', async () => {
  await withSlackDatabasePair(async ({ sql, database, space }, { sql: otherSql, database: otherDb, space: other }) => {
      const apps = new PostgresAppRepository(database);
      const credentials = new PostgresAppCredentialRepository(database, material);
      const otherCredentials = new PostgresAppCredentialRepository(otherDb, material);
      await credentials.put(oauthInput(space));
      await otherCredentials.put(oauthInput(other, 'T2'));
      assert.deepEqual(await readOAuth(apps), [{ connectionId: `${space}:slack`, spaceId: space }]);
      assert.deepEqual(await readOAuth(apps, { providerId: 'linear' }), []);
      assert.deepEqual(await readOAuth(apps, { appClientId: 'retired-app' }), []);
      await otherSql(`UPDATE data.app_connector_connections SET metadata_json='{"installationId":"T1"}' WHERE space_id=$1`, [other]);
      assert.deepEqual(await readOAuth(apps), [{ connectionId: `${space}:slack`, spaceId: space }], 'caller metadata never widens delivery');
      await otherCredentials.put(oauthInput(other));
      assert.equal((await readOAuth(apps)).length, 2, 'two Spaces may explicitly authorize the same workspace');
      await assert.rejects(readOAuth(apps, { limit: 1 }), /exceeds its bound/, 'overflow fails closed, never partially routes');
      await sql("UPDATE data.app_connector_connections SET status='disconnected' WHERE space_id=$1", [space]);
      assert.deepEqual(await readOAuth(apps), [{ connectionId: `${other}:slack`, spaceId: other }]);
      await otherSql('UPDATE data.app_connector_credentials SET version=version+1 WHERE space_id=$1', [other]);
      assert.deepEqual(await readOAuth(apps), [], 'mismatched credential versions never route');
  });
});

integration('subscription route reads recheck OAuth bindings after the initial installation lookup', async () => {
  await withDatabase(async ({ sql, database, space }) => {
    await useSlack(sql, space);
    const apps = new PostgresAppRepository(database);
    const credentials = new PostgresAppCredentialRepository(database, material);
    await credentials.put(oauthInput(space));
    await sql(`INSERT INTO data.channels (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,
      created_at,updated_at) VALUES ($2||':a',$2,'a','a','open',$2||':rank-a',1,$1,$1)`, [at, space]);
    await sql(`INSERT INTO data.app_source_relations (relation_id,connection_id,space_id,channel_id,source_kind,
      source_ref,features_json,version,created_by,created_at,updated_at) VALUES
      ($2||':r1',$2||':slack',$2,$2||':a','repository','slack:c1','["messages"]',1,'owner',$1,$1)`, [at, space]);
    const routes = () => apps.connectorEventRoutes({ requestId: crypto.randomUUID(), connectionId: `${space}:slack`,
      sourceRef: 'slack:c1', limit: 10, oauthBinding: { providerId: 'slack', appClientId: 'app-1', installationId: 'T1' } });
    assert.equal((await routes()).length, 1);
    await credentials.put(oauthInput(space, 'T2'));
    assert.deepEqual(await routes(), [], 'old workspace events cannot reach newly authorized workspace subscriptions');
  });
});

integration('concurrent OAuth callbacks leave one consistent final token, binding and ingress key', async () => {
  await withDatabase(async ({ sql, database, space }) => {
    await useSlack(sql, space);
    const credentials = new PostgresAppCredentialRepository(database, material);
    await Promise.all(['T1', 'T2'].map(team => credentials.put(oauthInput(space, team))));
    const row = (await sql('SELECT * FROM data.app_connector_oauth_installations WHERE space_id=$1', [space])).rows[0];
    const resolved = await credentials.resolve({ requestId: 'concurrent-read', spaceId: space, providerId: 'slack' });
    assert.equal(resolved.values.botToken, `fixture-${row.installation_id}`);
    assert.equal(resolved.version, Number(row.credential_version));
    assert.ok(['fixture-key-T1','fixture-key-T2'].includes(resolved.values.ingressKey));
  });
});


integration('scheduled Space deletion excludes OAuth delivery, restoration restores it, and purge leaves other grants alone', async () => {
  await withSlackDatabasePair(async ({ sql, database, space }, { sql: otherSql, database: otherDb, space: other }) => {
      await sql(`INSERT INTO control.postgres_shards (shard_id,state,capacity_class,created_at,updated_at)
        VALUES ('shard-0','active','test',now(),now()) ON CONFLICT DO NOTHING`);
      // Replace this test's synthetic memberships with the real createSpace grants.
      await sql('DELETE FROM data.space_members WHERE space_id=$1', [space]);
      await otherSql('DELETE FROM data.space_members WHERE space_id=$1', [other]);
      const spaces = new PostgresSpaceControlRepository(database, 'shard-0');
      for (const id of [space, other]) await spaces.createSpace({ requestId: `create-${id}`, commandId: `create-${id}`,
        spaceId: id, ownerUserId: 'owner', name: 'OAuth deletion test', metadata: { joinPolicy: 'open' } });
      const credentials = new PostgresAppCredentialRepository(database, material);
      const otherCredentials = new PostgresAppCredentialRepository(otherDb, material);
      const apps = new PostgresAppRepository(database);
      await credentials.put(oauthInput(space));
      await otherCredentials.put(oauthInput(other));
      const ids = async () => (await readOAuth(apps)).map(row => row.spaceId).sort();
      assert.deepEqual(await ids(), [space, other].sort());
      const remove = () => spaces.mutateSpace({ requestId: crypto.randomUUID(), commandId: crypto.randomUUID(),
        actorUserId: 'owner', at: new Date().toISOString(), kind: 'space_delete', spaceId: space });
      await remove();
      assert.deepEqual(await ids(), [other], 'scheduled deletion immediately blocks incoming delivery');
      await spaces.restoreSpace({ requestId: crypto.randomUUID(), commandId: crypto.randomUUID(), actorUserId: 'owner',
        spaceId: space, at: new Date().toISOString() });
      assert.deepEqual(await ids(), [space, other].sort());
      const again = await remove();
      const due = new Date(Date.parse(again.deletion.purgeAfter)+1000).toISOString();
      let status;
      for (let guard=0; guard<500; guard++) {
        const step=await spaces.purgeSpaceStep({ requestId: crypto.randomUUID(), spaceId: space, now: due });
        status=step.status;
        if(status==='objects') await spaces.recordSpacePurgeObjects({ requestId: crypto.randomUUID(), spaceId: space,
          cursor: step.cursor, exhausted: step.exhausted, deleted: step.objectKeys.length, now: due });
        else if(status!=='rows') break;
      }
      assert.equal(status, 'completed');
      assert.deepEqual(await ids(), [other]);
      assert.equal((await sql('SELECT count(*)::int AS n FROM data.app_connector_oauth_installations WHERE space_id=$1', [space])).rows[0].n, 0);
  });
});


const sentryApp = "aa111111-2222-3333-4444-555555555555";
const sentryInstall = "bb111111-2222-3333-4444-555555555555";
async function withSentryAuthority(run) {
  await withDatabase(async context => {
    const { sql, database, space } = context;
    await sql("UPDATE data.app_connector_connections SET connection_id=$2,provider_id='sentry',status='disconnected' WHERE space_id=$1",
      [space, `${space}:sentry`]);
    const credentials = new PostgresAppCredentialRepository(database, material);
    const apps = new PostgresAppRepository(database);
    const installationId = crypto.randomUUID();
    const fields = { oauthToken: "native-access", oauthRefreshToken: "native-refresh", oauthExpiresAt: String(Date.now()+28_800_000),
      oauthClientId: "sentry-client", oauthAppUuid: sentryApp, oauthAppSlug: "xmatrix", oauthInstallationId: installationId,
      oauthOrganization: "made-by-robot", oauthOrganizationId: "42", oauthScopes: "event:read event:write org:read project:read" };
    const nativePolicy = { allowed: [...Object.keys(fields), "apiToken", "ingressKey"] };
    const base = { requestId: crypto.randomUUID(), spaceId: space, providerId: "sentry", actorUserId: "owner",
      fields, policy: nativePolicy, at,
      oauthInstallation: { appClientId: fields.oauthClientId, installationId, eventScopeId: sentryApp } };
    const snapshot = () => credentials.beginSentryInstallation({ requestId: crypto.randomUUID(), spaceId: space,
      actorUserId: "owner", installation: base.oauthInstallation });
    const install = async (overrides = {}) => credentials.put({ ...base, requestId: crypto.randomUUID(),
      verifiedInstallation: Object.hasOwn(overrides, "verifiedInstallation") ? overrides.verifiedInstallation : await snapshot(), ...overrides });
    const connectionRow = async () => (await sql("SELECT * FROM data.app_connector_connections WHERE space_id=$1", [space])).rows[0];
    try { await run({ ...context, credentials, apps, fields, nativePolicy, base, snapshot, install, connectionRow, installationId }); }
    finally { await sql("DELETE FROM data.app_sentry_installation_lifecycle WHERE installation_uuid=$1::uuid",
      [installationId]); }
  });
}

integration("verified Sentry installation atomically replaces credentials, binds its app UUID and activates", async () => {
  await withSentryAuthority(async ({ sql, space, credentials, nativePolicy, install, snapshot, connectionRow, fields }) => {
    await credentials.put({ requestId: "old-manual", spaceId: space, providerId: "sentry", actorUserId: "owner",
      fields: { apiToken: "old-manual-secret" }, policy: nativePolicy, at });
    const before = await snapshot();
    const result = await install();
    assert.ok(result.credentialFields.includes("oauthInstallationId"));
    assert.ok(!result.credentialFields.includes("apiToken"));
    const resolved = await credentials.resolve({ requestId: "read-native", spaceId: space, providerId: "sentry" });
    assert.deepEqual(resolved.values, fields);
    assert.equal(resolved.status, "configured");
    const row = await connectionRow();
    assert.equal(Number(row.version), before.connectionVersion + 1);
    assert.equal(new Date(row.last_checked_at).toISOString(), at);
    const binding = (await sql("SELECT * FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0];
    assert.equal(binding.installation_id, fields.oauthInstallationId);
    assert.equal(binding.event_scope_id, sentryApp);
    assert.match(binding.grant_generation, /^[a-f0-9-]{36}$/u);
    assert.equal(Number(binding.credential_version), resolved.version);
    const stored = (await sql("SELECT * FROM data.app_connector_credentials WHERE space_id=$1", [space])).rows[0];
    assert.doesNotMatch(JSON.stringify(stored), /native-access|native-refresh|old-manual-secret/u);
    assert.doesNotMatch(JSON.stringify(result), /native-access|native-refresh/u);
  });
});

integration("Sentry installation loses to a concurrent reconnect, credential edit or empty-grant ABA", async () => {
  for (const change of ["reconnect", "credential-edit", "write-clear", "delete-recreate"]) await withSentryAuthority(async context => {
    const { sql, space, credentials, nativePolicy, install, snapshot, connectionRow } = context;
    const original = await snapshot();
    if (change === "delete-recreate") {
      await sql("DELETE FROM data.app_connector_connections WHERE space_id=$1", [space]);
      await context.apps.upsert({ commandId: `recreate-${space}`, spaceId: space, actorUserId: "owner", at,
        provider: { id: "sentry", name: "Sentry", authMode: "oauth", scopes: [], secretRefs: [], capabilities: [], metadataFields: [] },
        body: { status: "disconnected", initializeOnly: true } });
      const replacement = await credentials.installationSnapshot({ requestId: "replacement-snapshot", spaceId: space, actorUserId: "owner" });
      assert.equal(replacement.connectionVersion, original.connectionVersion);
      assert.equal(replacement.credentialVersion, original.credentialVersion);
      assert.notEqual(replacement.connectionGeneration, original.connectionGeneration);
    } else if (change === "reconnect") await sql("UPDATE data.app_connector_connections SET version=version+1,status='disconnected' WHERE space_id=$1", [space]);
    else {
      await credentials.put({ requestId: "concurrent-write", spaceId: space, providerId: "sentry", actorUserId: "owner",
        fields: { apiToken: "new-manual" }, policy: nativePolicy, at });
      if (change === "write-clear") await credentials.put({ requestId: "concurrent-clear", spaceId: space,
        providerId: "sentry", actorUserId: "owner", fields: { apiToken: null }, policy: nativePolicy, at });
    }
    const before = await connectionRow();
    await assert.rejects(install({ verifiedInstallation: original }), error => error.status === 409);
    const after = await connectionRow();
    assert.equal(Number(after.version), Number(before.version));
    assert.equal(after.status, before.status);
    assert.equal((await sql("SELECT count(*)::int n FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0].n, 0);
    const grant = await credentials.resolve({ requestId: "after-conflict", spaceId: space, providerId: "sentry" });
    assert.equal(grant?.values.oauthToken, undefined);
    if (change === "credential-edit") assert.equal(grant.values.apiToken, "new-manual");
  });
});

integration("only one of two Sentry installation completions can commit the original snapshot", async () => {
  await withSentryAuthority(async ({ install, snapshot, connectionRow }) => {
    const original = await snapshot();
    const results = await Promise.allSettled([install({ verifiedInstallation: original }), install({ verifiedInstallation: original })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.status, 409);
    assert.equal(Number((await connectionRow()).version), original.connectionVersion + 1);
  });
});

integration("revoked admin and pending Space deletion cannot persist a verified Sentry installation", async () => {
  for (const condition of ["member", "deleted-member", "deletion"]) await withSentryAuthority(async ({ sql, space, install, snapshot }) => {
    const original = await snapshot();
    if (condition === "member") await sql("UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id='owner'", [space]);
    if (condition === "deleted-member") await sql("DELETE FROM data.space_members WHERE space_id=$1 AND user_id='owner'", [space]);
    if (condition === "deletion") {
      // Use the actual lifecycle table, not a projection of browser membership.
      await sql(`INSERT INTO data.space_deletions(space_id,space_name,owner_user_id,requested_at,purge_after,state,
        members_json,automations_json,version,updated_at) VALUES($1,'test','owner',$2,$2::timestamptz+interval '1 day',
        'scheduled','[]','[]',1,$2)`, [space, at]);
    }
    try { await assert.rejects(install({ verifiedInstallation: original }), error => error.status === 404); }
    finally { await sql("DELETE FROM data.space_deletions WHERE space_id=$1", [space]); }
    assert.equal((await sql("SELECT count(*)::int n FROM data.app_connector_credentials WHERE space_id=$1", [space])).rows[0].n, 0);
  });
});

integration("invalid Sentry binding and incomplete grant cannot activate or overwrite a connection", async () => {
  await withSentryAuthority(async ({ install, fields, connectionRow }) => {
    for (const overrides of [{ verifiedInstallation: undefined }, { oauthInstallation: { appClientId: "other", installationId: sentryInstall, eventScopeId: sentryApp } },
      { fields: { ...fields, oauthRefreshToken: null } }, { fields: { ...fields, oauthAppSlug: null } },
      { asHub: true }, { fields: { ...fields, oauthScopes: "org:read" } },
      ...fields.oauthScopes.split(" ").map(missing => ({ fields: { ...fields,
        oauthScopes: fields.oauthScopes.split(" ").filter(scope => scope !== missing).join(" ") } })),
      { fields: { ...fields, oauthScopes: `${fields.oauthScopes} org:write` } },
      { fields: { ...fields, oauthScopes: "event:read event:write org:read org:read" } }]) {
      await assert.rejects(install(overrides), error => error.status === 400);
    }
    assert.equal((await connectionRow()).status, "disconnected");
  });
});

integration("server refresh preserves the Sentry binding while a Human credential edit retires it", async () => {
  await withSentryAuthority(async ({ install, credentials, space, nativePolicy, sql, connectionRow, installationId }) => {
    await install();
    const original = Number((await connectionRow()).version);
    const generation = (await sql("SELECT grant_generation FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0].grant_generation;
    const installSnapshot = await credentials.beginSentryInstallation({ requestId: "before-refresh-snapshot", spaceId: space,
      actorUserId: "owner", installation: { appClientId: "sentry-client", installationId, eventScopeId: sentryApp } });
    const old = await credentials.resolve({ requestId: "before-rotation", spaceId: space, providerId: "sentry" });
    await credentials.put({ requestId: "server-rotation", spaceId: space, providerId: "sentry", actorUserId: "owner",
      asHub: true, expectedVersion: old.version, fields: { oauthToken: "rotated-access", oauthRefreshToken: "rotated-refresh" }, policy: nativePolicy, at });
    assert.equal(Number((await connectionRow()).version), original);
    assert.equal((await sql("SELECT grant_generation FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0].grant_generation, generation);
    await assert.rejects(install({ verifiedInstallation: installSnapshot }), error => error.status === 409);
    assert.equal((await credentials.resolve({ requestId: "refresh-wins", spaceId: space, providerId: "sentry" })).values.oauthToken, "rotated-access");
    assert.equal(Number((await sql("SELECT credential_version FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0].credential_version), old.version + 1);
    await credentials.put({ requestId: "human-replacement", spaceId: space, providerId: "sentry", actorUserId: "owner",
      fields: { apiToken: "manual-replacement" }, policy: nativePolicy, at });
    assert.equal((await sql("SELECT count(*)::int n FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0].n, 0);
    assert.equal(Number((await connectionRow()).version), original + 1);
  });
});

integration("create-only App preparation preserves an existing verified grant and command replay", async () => {
  await withSentryAuthority(async ({ install, apps, space, connectionRow }) => {
    await install();
    const before = await connectionRow();
    const input = { commandId: `initialize-sentry-${space}`, spaceId: space, actorUserId: "owner", at,
      provider: { id: "sentry", name: "Sentry", authMode: "oauth", scopes: [], secretRefs: [], capabilities: [], metadataFields: [] },
      body: { initializeOnly: true, status: "disconnected" } };
    const first = await apps.upsert(input), replay = await apps.upsert(input);
    assert.equal(first.connection.status, "configured");
    assert.equal(first.connection.version, Number(before.version));
    assert.equal(replay.reused, true);
    assert.equal((await connectionRow()).status, "configured");
    await assert.rejects(apps.upsert({ ...input, commandId: `${input.commandId}-member`, actorUserId: "member" }), error => error.status === 404);
    await assert.rejects(apps.upsert({ ...input, commandId: `${input.commandId}-invalid`, body: { initializeOnly: "true" } }), error => error.status === 400);
  });
});


integration("a failed Sentry binding write rolls the entire grant replacement back", async () => {
  await withSentryAuthority(async ({ install, snapshot, database, base, credentials, connectionRow, sql, space, installationId }) => {
    await install();
    const original = await snapshot();
    const before = await credentials.resolve({ requestId: "before-failure", spaceId: space, providerId: "sentry" });
    const failing = new PostgresAppCredentialRepository({ cacheMode: "disabled", transaction: (context, operation) =>
      database.transaction(context, tx => operation({ ...tx, query: query => {
        if (query.name === "app_oauth_installation_bind_v3") throw new Error("injected binding failure");
        return tx.query(query);
      } })) }, material);
    await assert.rejects(failing.put({ ...base, verifiedInstallation: original,
      fields: { ...base.fields, oauthToken: "replacement-access" } }), /injected binding failure/u);
    const after = await credentials.resolve({ requestId: "after-failure", spaceId: space, providerId: "sentry" });
    assert.deepEqual(after.values, before.values);
    assert.equal(after.version, before.version);
    assert.equal(Number((await connectionRow()).version), original.connectionVersion);
    assert.equal((await sql("SELECT installation_id FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0].installation_id, installationId);
  });
});

integration("Sentry migration rejects malformed app UUIDs without changing an existing binding", async () => {
  await withSentryAuthority(async ({ install, sql, space }) => {
    await install();
    for (const scope of [null, "team_vercel", "not-a-uuid", sentryApp.toUpperCase()]) {
      await assert.rejects(sql("UPDATE data.app_connector_oauth_installations SET event_scope_id=$2 WHERE space_id=$1", [space, scope]),
        error => error.code === "23514");
    }
    await assert.rejects(sql("UPDATE data.app_connector_oauth_installations SET installation_id='arbitrary' WHERE space_id=$1", [space]), error => error.code === "23514");
    assert.equal((await sql("SELECT event_scope_id FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0].event_scope_id, sentryApp);
  });
});


integration("signed Sentry uninstall before or during installation prevents activation, including retries", async () => {
  for (const timing of ["before", "during", "after"]) await withSentryAuthority(async context => {
    const { credentials, base, installationId, snapshot, install, connectionRow, space, sql } = context;
    const retire = overrides => credentials.retireSentryInstallation({ requestId: crypto.randomUUID(),
      appClientId: base.oauthInstallation.appClientId, appUuid: sentryApp, installationId, at, limit: 50, ...overrides });
    const proof = timing === "before" ? null : await snapshot();
    if (timing === "after") await install({ verifiedInstallation: proof });
    assert.equal(await retire(), timing === "after" ? 1 : 0);
    assert.equal(await retire(), 0, "signed retry is idempotent");
    if (proof) await assert.rejects(install({ verifiedInstallation: proof }), error => error.status === 409);
    await assert.rejects(snapshot(), error => error.code === "installation_retired");
    assert.equal((await connectionRow()).status, "disconnected");
    assert.equal(await credentials.resolve({ requestId: "retired-grant", spaceId: space, providerId: "sentry" }), null);
    assert.equal((await sql("SELECT count(*)::int n FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0].n, 0);
    const state = (await sql("SELECT * FROM data.app_sentry_installation_lifecycle WHERE installation_uuid=$1::uuid", [installationId])).rows[0];
    assert.equal(state.attempt_id, null);
    assert.ok(state.retired_at);
    assert.doesNotMatch(JSON.stringify(state), /native-access|native-refresh|oauthToken|actor|code/u);
  });
});

integration("Sentry installation attempts are single-use, short-lived, Space-bound and token-expiry bounded", async () => {
  await withSentryAuthority(async ({ snapshot, install, sql, installationId, fields }) => {
    let proof = await snapshot();
    await sql("UPDATE data.app_sentry_installation_lifecycle SET attempt_expires_at=statement_timestamp()-interval '1 second' WHERE installation_uuid=$1::uuid", [installationId]);
    await assert.rejects(install({ verifiedInstallation: proof }), error => error.status === 409);
    proof = await snapshot();
    await assert.rejects(install({ verifiedInstallation: { ...proof, attemptId: crypto.randomUUID() } }), error => error.status === 409);
    await assert.rejects(install({ verifiedInstallation: proof, fields: { ...fields, oauthExpiresAt: String(Date.now()-1000) } }), error => error.status === 409);
    await assert.rejects(install({ verifiedInstallation: proof, fields: { ...fields, oauthExpiresAt: String(Date.now()+172800000) } }), error => error.status === 409);
    await install({ verifiedInstallation: proof });
    await assert.rejects(install({ verifiedInstallation: proof }), error => error.status === 409);
  });
  await withSentryAuthority(async first => {
    await withSentryAuthority(async second => {
      const proof = await first.snapshot();
      await assert.rejects(second.install({ verifiedInstallation: proof, oauthInstallation: first.base.oauthInstallation,
        fields: { ...second.fields, oauthInstallationId: first.installationId } }), error => error.status === 409);
      assert.equal((await second.connectionRow()).status, "disconnected");
      await first.install({ verifiedInstallation: proof });
    });
  });
});

integration("expired retirement cleanup cannot reactivate an old in-flight installation attempt", async () => {
  await withSentryAuthority(async ({ credentials, base, installationId, snapshot, install, sql }) => {
    const proof = await snapshot();
    await credentials.retireSentryInstallation({ requestId: crypto.randomUUID(), appClientId: base.oauthInstallation.appClientId,
      appUuid: sentryApp, installationId, at, limit: 50 });
    await sql("UPDATE data.app_sentry_installation_lifecycle SET expires_at=statement_timestamp()-interval '1 second' WHERE installation_uuid=$1::uuid", [installationId]);
    const fresh = await snapshot();
    assert.notEqual(fresh.attemptId, proof.attemptId);
    await assert.rejects(install({ verifiedInstallation: proof }), error => error.status === 409);
    await install({ verifiedInstallation: fresh });
  });
});

integration("concurrent Sentry completion and uninstall always finish disconnected without a grant", async () => {
  for (let round = 0; round < 3; round++) await withSentryAuthority(async ({ credentials, base, space,
    installationId, snapshot, install, connectionRow, sql }) => {
    const proof = await snapshot();
    const [completion, retirement] = await Promise.allSettled([
      install({ verifiedInstallation: proof }),
      credentials.retireSentryInstallation({ requestId: crypto.randomUUID(), appClientId: base.oauthInstallation.appClientId,
        appUuid: sentryApp, installationId, at, limit: 50 }),
    ]);
    assert.equal(retirement.status, "fulfilled");
    if (completion.status === "rejected") assert.equal(completion.reason.status, 409);
    assert.equal((await connectionRow()).status, "disconnected");
    assert.equal(await credentials.resolve({ requestId: "concurrent-final", spaceId: space, providerId: "sentry" }), null);
    assert.equal((await sql("SELECT count(*)::int n FROM data.app_connector_oauth_installations WHERE space_id=$1", [space])).rows[0].n, 0);
  });
});

integration("Sentry uninstall leaves a replacement UUID intact and failures roll retirement back", async () => {
  await withSentryAuthority(async ({ install, credentials, database, base, space, sql, installationId, connectionRow }) => {
    await install();
    const old = { requestId: crypto.randomUUID(), appClientId: base.oauthInstallation.appClientId,
      appUuid: sentryApp, installationId, at, limit: 50 };
    assert.equal(await credentials.retireSentryInstallation({ ...old, appClientId: "other-app" }), 0);
    assert.equal((await connectionRow()).status, "configured");
    const failing = new PostgresAppCredentialRepository({ cacheMode: "disabled", transaction: (context, operation) =>
      database.transaction(context, tx => operation({ ...tx, query: query => {
        if (query.name === "app_sentry_retire_connection_v1") throw new Error("injected retirement failure");
        return tx.query(query);
      } })) }, material);
    await assert.rejects(failing.retireSentryInstallation(old), /injected retirement failure/u);
    assert.equal((await connectionRow()).status, "configured");
    assert.equal((await credentials.resolve({ requestId: "retirement-rollback", spaceId: space, providerId: "sentry" })).values.oauthToken, "native-access");
    const newId = crypto.randomUUID();
    const binding = { ...base.oauthInstallation, installationId: newId };
    const proof = await credentials.beginSentryInstallation({ requestId: "new-install", spaceId: space, actorUserId: "owner", installation: binding });
    try {
      await install({ verifiedInstallation: proof, oauthInstallation: binding, fields: { ...base.fields, oauthInstallationId: newId } });
      assert.equal(await credentials.retireSentryInstallation(old), 0);
      assert.equal((await connectionRow()).status, "configured");
      assert.equal((await credentials.resolve({ requestId: "replacement-survives", spaceId: space, providerId: "sentry" })).values.oauthInstallationId, newId);
    } finally {
      await sql("DELETE FROM data.app_sentry_installation_lifecycle WHERE installation_uuid=ANY($1::uuid[])", [[newId]]);
    }
  });
});

integration("Sentry uninstall fanout overflow fails before changing any binding or lifecycle", async () => {
  await withSentryAuthority(async first => {
    await withSentryAuthority(async second => {
      const binding = first.base.oauthInstallation;
      await first.install();
      const proof = await second.credentials.beginSentryInstallation({ requestId: "shared-install", spaceId: second.space,
        actorUserId: "owner", installation: binding });
      await second.install({ verifiedInstallation: proof, oauthInstallation: binding,
        fields: { ...second.fields, oauthInstallationId: first.installationId } });
      const retire = limit => first.credentials.retireSentryInstallation({ requestId: crypto.randomUUID(),
        appClientId: binding.appClientId, appUuid: sentryApp, installationId: binding.installationId, at, limit });
      await assert.rejects(retire(1), error => error.status === 503);
      assert.equal((await first.connectionRow()).status, "configured");
      assert.equal((await second.connectionRow()).status, "configured");
      assert.equal((await first.sql("SELECT retired_at FROM data.app_sentry_installation_lifecycle WHERE installation_uuid=$1::uuid", [first.installationId])).rows[0].retired_at, null);
      assert.equal(await retire(50), 2);
      assert.equal(await retire(50), 0);
    });
  });
});

const discordFields = { oauthToken: "fixture-user-access", oauthRefreshToken: "fixture-user-refresh", oauthExpiresAt: "1893456000000",
  oauthClientId: "123456789012345678", oauthGuildId: "223456789012345678", oauthUserId: "323456789012345678",
  oauthScopes: "bot identify", botToken: null };
const discordPolicy = { allowed: Object.keys(discordFields) };
async function withDiscordDatabase(run) {
  await withDatabase(async context => {
    await context.sql("UPDATE data.app_connector_connections SET connection_id=$1||':discord',provider_id='discord',provider_name='Discord' WHERE space_id=$1", [context.space]);
    const repository = new PostgresAppCredentialRepository(context.database, material);
    const snapshot = () => repository.installationSnapshot({ requestId: crypto.randomUUID(), spaceId: context.space, providerId: "discord", actorUserId: "owner" });
    const install = original => repository.put({ requestId: crypto.randomUUID(), spaceId: context.space, providerId: "discord", actorUserId: "owner",
      fields: discordFields, policy: discordPolicy, expectedInstallationSnapshot: original, at });
    await run({ ...context, repository, snapshot, install });
  });
}

integration("Discord callback snapshot belongs to the live Space admin and stores only an encrypted user grant", async () => {
  await withDiscordDatabase(async ({ repository, snapshot, install, space, sql }) => {
    await assert.rejects(repository.installationSnapshot({ requestId: "denied", spaceId: space, providerId: "discord", actorUserId: "member" }), error => error.status === 404);
    const original = await snapshot(); await install(original);
    const resolved = await repository.resolve({ requestId: "resolve", spaceId: space, providerId: "discord" });
    assert.equal(resolved.values.oauthGuildId, discordFields.oauthGuildId); assert.equal(resolved.values.botToken, undefined);
    assert.equal(resolved.connectionVersion, original.connectionVersion + 1); assert.equal(resolved.connectionGeneration, original.connectionGeneration);
    const stored = (await sql("SELECT * FROM data.app_connector_credentials WHERE space_id=$1", [space])).rows[0];
    assert.doesNotMatch(JSON.stringify(stored), /fixture-user-access|fixture-user-refresh|223456789012345678/);
    await assert.rejects(install(original), error => error.status === 409);
  });
});

integration("parallel Discord callbacks serialize on the original connection and only one can commit", async () => {
  await withDiscordDatabase(async ({ snapshot, install }) => {
    const original = await snapshot();
    const results = await Promise.allSettled([install(original), install(original)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
  });
});

integration("Discord disconnect, credential ABA and deleted/recreated connection generation fence delayed callbacks", async () => {
  for (const mutation of ["disconnect", "credential", "generation"]) {
    await withDiscordDatabase(async ({ repository, snapshot, install, sql, space }) => {
      const original = await snapshot();
      if (mutation === "disconnect") await sql("UPDATE data.app_connector_connections SET version=version+1,status='disconnected' WHERE space_id=$1", [space]);
      if (mutation === "credential") {
        await repository.put({ requestId: "manual", spaceId: space, providerId: "discord", actorUserId: "owner", fields: { botToken: "own-bot" }, policy: discordPolicy, at });
        await repository.put({ requestId: "clear", spaceId: space, providerId: "discord", actorUserId: "owner", fields: { botToken: null }, policy: discordPolicy, at });
      }
      if (mutation === "generation") await sql("UPDATE data.app_connector_connections SET search_rank_sequence=search_rank_sequence||':recreated' WHERE space_id=$1", [space]);
      await assert.rejects(install(original), error => error.status === 409);
    });
  }
});

integration("explicit manual Discord edits clear the native grant, and refresh cannot revive it", async () => {
  await withDiscordDatabase(async ({ repository, snapshot, install, space }) => {
    await install(await snapshot()); const native = await repository.resolve({ requestId: "before", spaceId: space, providerId: "discord" });
    await repository.put({ requestId: "manual", spaceId: space, providerId: "discord", actorUserId: "owner", fields: { botToken: "own-bot" }, policy: discordPolicy, at });
    const manual = await repository.resolve({ requestId: "after", spaceId: space, providerId: "discord" });
    assert.deepEqual(manual.values, { botToken: "own-bot" });
    await assert.rejects(repository.put({ requestId: "stale-refresh", spaceId: space, providerId: "discord", actorUserId: "hub:oauth-refresh", asHub: true,
      expectedVersion: native.version, fields: { oauthToken: "new-token" }, policy: discordPolicy, at }), error => error.status === 409);
    await assert.rejects(repository.put({ requestId: "unbound", spaceId: space, providerId: "discord", actorUserId: "owner", fields: discordFields,
      policy: discordPolicy, at }), error => error.status === 400);
  });
});


integration("revoked Space administration cannot commit a previously started Discord grant", async () => {
  await withDiscordDatabase(async ({ snapshot, install, sql, space }) => {
    const original = await snapshot();
    await sql("UPDATE data.space_members SET role='member',version=version+1 WHERE space_id=$1 AND user_id='owner'", [space]);
    await assert.rejects(install(original), error => error.status === 404);
    assert.equal((await sql("SELECT count(*) FROM data.app_connector_credentials WHERE space_id=$1", [space])).rows[0].count, "0");
  });
});
