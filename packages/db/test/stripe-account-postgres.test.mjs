import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { connectorDatabase, integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import { PostgresStripeAccountRepository, PostgresAppCredentialRepository } from "../dist/index.js";
import { encryptSecretValue } from "../dist/secret-value-control.js";

const material = "stripe-account-fixture-key", clientId = "ca_fixture";
const a = "acct_first", b = "acct_second";
function grant(id, changes = {}) {
  return { accountId: id, appClientId: clientId, name: id, generation: crypto.randomUUID(),
    accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: Date.now() + 3_600_000,
    authorizedAt: new Date(Date.now() - 5_000).toISOString(), ...changes };
}

async function seed(sql, spaceId) {
  await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
    VALUES ($1,'stripe-owner','owner',1,now(),now()),($1,'stripe-member','member',1,now(),now())`, [spaceId]);
  await sql(`INSERT INTO data.app_connector_connections
    (connection_id,space_id,provider_id,provider_name,auth_mode,status,version,created_by,search_rank_sequence,
      channel_ids_json,capabilities_json,secret_refs_json,scopes_json,created_at,updated_at)
    VALUES ($1||':stripe',$1,'stripe','Stripe','oauth','configured',1,'stripe-owner',$2,'[]','[]','[]','[]',now(),now())`,
  [spaceId, crypto.randomUUID()]);
}

async function fixture(run) {
  const { client, database, sql } = await connectorDatabase("stripe-accounts-test");
  const spaceId = `stripe-accounts-${crypto.randomUUID()}`;
  try {
    await seed(sql, spaceId);
    const repository = new PostgresStripeAccountRepository(database, material);
    const snapshot = async () => {
      const row = (await sql("SELECT version,search_rank_sequence FROM data.app_connector_connections WHERE connection_id=$1", [`${spaceId}:stripe`])).rows[0];
      return { connectionVersion: Number(row.version), connectionGeneration: row.search_rank_sequence };
    };
    const connect = async value => repository.connect({ spaceId, actorUserId: "stripe-owner", grant: value, snapshot: await snapshot() });
    const route = id => repository.eventConnections({ appClientId: clientId, accountId: id, limit: 50 });
    const list = () => repository.list({ spaceId, actorUserId: "stripe-owner" });
    const claim = id => repository.claimRefresh({ spaceId, accountId: id, appClientId: clientId });
    await run({ repository, database, sql, spaceId, snapshot, connect, route, list, claim });
  } finally {
    await sql("DELETE FROM data.app_connector_credentials WHERE space_id=$1", [spaceId]);
    await sql("DELETE FROM data.app_connector_connections WHERE space_id=$1", [spaceId]);
    await sql("DELETE FROM data.space_members WHERE space_id=$1", [spaceId]);
    await database.close?.(); await client.end();
  }
}

integration("adding and reconnecting one Stripe merchant preserves other merchants and exposes no token", async () => {
  await fixture(async ({ repository, sql, spaceId, connect, list, route, claim }) => {
    const first = grant(a); await connect(first); await connect(grant(b));
    assert.deepEqual((await list()).accounts.map(account => account.id), [a, b]);
    assert.equal((await route(a))[0].spaceId, spaceId); assert.equal((await route(b))[0].spaceId, spaceId);
    assert.equal((await claim(a)).grant.accessToken, `access-${a}`);
    assert.doesNotMatch(JSON.stringify(await list()), /access-|refresh-/);
    const stored = (await sql("SELECT * FROM data.app_stripe_account_grants WHERE space_id=$1", [spaceId])).rows;
    assert.doesNotMatch(JSON.stringify(stored), /access-acct|refresh-acct/);
    const originalB = stored.find(row => row.account_id === b).encrypted_value_json;
    await sql("UPDATE data.app_stripe_account_grants SET encrypted_value_json=$2::jsonb WHERE connection_id=$1 AND account_id=$3",
      [`${spaceId}:stripe`, JSON.stringify(stored.find(row => row.account_id === a).encrypted_value_json), b]);
    await assert.rejects(claim(b), /integrity check/);
    await sql("UPDATE data.app_stripe_account_grants SET encrypted_value_json=$2::jsonb WHERE connection_id=$1 AND account_id=$3",
      [`${spaceId}:stripe`, JSON.stringify(originalB), b]);
    await assert.rejects(repository.list({ spaceId, actorUserId: "stripe-member" }));
    const replacement = grant(a, { accessToken: "new-access-a", refreshToken: "new-refresh-a" });
    await connect(replacement);
    await repository.rejectGrant({ spaceId, accountId: a, generation: first.generation });
    await assert.rejects(repository.remove({ spaceId, actorUserId: "stripe-owner", accountId: a, generation: first.generation }), /changed/);
    assert.equal((await claim(b)).grant.accessToken, `access-${b}`);
    assert.equal((await claim(a)).grant.accessToken, "new-access-a");
  });
});

integration("revocation retires only the named account and replay cannot retire a newer authorization", async () => {
  await fixture(async ({ repository, spaceId, connect, route, list }) => {
    await connect(grant(a)); await connect(grant(b));
    const eventAt = new Date(Date.now() - 2_000).toISOString();
    const retire = () => repository.retireAccount({ appClientId: clientId, accountId: a, eventAt, limit: 50 });
    assert.equal(await retire(), 1); assert.deepEqual(await route(a), []); assert.equal((await route(b)).length, 1);
    assert.equal((await list()).accounts.find(account => account.id === a).status, "reconnect");
    await connect(grant(a, { authorizedAt: new Date().toISOString() }));
    assert.equal(await retire(), 0); assert.equal((await route(a)).length, 1);
    const newest = (await list()).accounts.find(account => account.id === a);
    await repository.remove({ spaceId, actorUserId: "stripe-owner", accountId: a, generation: newest.generation });
    assert.equal((await route(b)).length, 1);
  });
});

integration("rotating refresh is leased per account; its exact commit is replayable and late responses cannot resurrect a grant", async () => {
  await fixture(async ({ repository, spaceId, connect, claim, route }) => {
    await connect(grant(a, { expiresAt: Date.now() - 1 })); await connect(grant(b));
    const competing = await Promise.allSettled([claim(a), claim(a)]);
    assert.equal(competing.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(competing.filter(value => value.status === "rejected")[0].reason.status, 503);
    const leased = competing.find(value => value.status === "fulfilled").value;
    assert.equal((await claim(b)).lease, null);
    const rotated = { ...leased.grant, accessToken: "rotated-a", refreshToken: "rotated-refresh-a", expiresAt: Date.now() + 3_600_000 };
    await repository.finishRefresh({ spaceId, claim: leased, grant: rotated });
    await repository.finishRefresh({ spaceId, claim: leased, grant: rotated });
    assert.equal((await claim(a)).grant.accessToken, "rotated-a");
    await connect(grant(a, { expiresAt: Date.now() - 1 }));
    const stale = await claim(a);
    await connect(grant(a, { accessToken: "reconnected-a", refreshToken: "reconnected-refresh-a" }));
    await assert.rejects(repository.finishRefresh({ spaceId, claim: stale, grant: { ...stale.grant,
      accessToken: "late-a", refreshToken: "late-refresh-a", expiresAt: Date.now() + 3_600_000 } }), /changed/);
    assert.equal((await claim(a)).grant.accessToken, "reconnected-a");
    assert.equal((await route(b)).length, 1);
  });
});

integration("failed refresh and explicit credential replacement do not revive a removed or different Stripe grant", async () => {
  await fixture(async ({ repository, database, spaceId, connect, claim, route, list }) => {
    await connect(grant(a, { expiresAt: Date.now() - 1 })); await connect(grant(b));
    const leased = await claim(a); await repository.finishRefresh({ spaceId, claim: leased });
    assert.deepEqual(await route(a), []); assert.equal((await route(b)).length, 1);
    assert.equal((await list()).accounts.find(account => account.id === a).status, "reconnect");
    await repository.rejectGrant({ spaceId, accountId: b, generation: (await claim(b)).grant.generation });
    assert.deepEqual(await route(b), []);
    const credentials = new PostgresAppCredentialRepository(database, material);
    await credentials.put({ requestId: crypto.randomUUID(), spaceId, providerId: "stripe", actorUserId: "stripe-owner",
      fields: { signingSecret: "whsec_manual_fixture" }, policy: { allowed: ["signingSecret"] }, at: new Date().toISOString() });
    assert.deepEqual((await list()).accounts, []); assert.deepEqual(await route(b), []);
  });
});

integration("concurrent callbacks fail without overwriting and a disconnect fences the original signed snapshot", async () => {
  await fixture(async ({ repository, sql, spaceId, snapshot, connect, route, list }) => {
    const original = await snapshot();
    const outcomes = await Promise.allSettled([a, b].map(id => repository.connect({ spaceId, actorUserId: "stripe-owner", grant: grant(id), snapshot: original })));
    assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
    assert.equal((await list()).accounts.length, 1);
    await sql("UPDATE data.app_connector_connections SET status='disconnected',version=version+1 WHERE connection_id=$1", [`${spaceId}:stripe`]);
    await assert.rejects(repository.connect({ spaceId, actorUserId: "stripe-owner", grant: grant("acct_late"), snapshot: original }), /changed/);
    assert.deepEqual(await route(a), []); assert.deepEqual(await route(b), []);
    // Re-adding through a fresh consent is an explicit new decision.
    await connect(grant("acct_late")); assert.equal((await route("acct_late")).length, 1);
    assert.deepEqual(await route(a), []); assert.deepEqual(await route(b), []);
  });
});

integration("merchant pagination has no account-count ceiling and every page contains metadata only", async () => {
  await fixture(async ({ repository, sql, spaceId, connect }) => {
    await connect(grant(a));
    await sql(`INSERT INTO data.app_stripe_account_grants
      (connection_id,space_id,account_id,app_client_id,display_name,grant_generation,authorized_at,connected_by,status,
        credential_version,envelope_kind,encrypted_value_json,updated_at)
      SELECT connection_id,space_id,'acct_page'||lpad(n::text,3,'0'),app_client_id,'Merchant '||n,
        gen_random_uuid(),authorized_at,connected_by,'reconnect',1,'account',NULL,updated_at
      FROM data.app_stripe_account_grants CROSS JOIN generate_series(1,60) n WHERE connection_id=$1 AND account_id=$2`, [`${spaceId}:stripe`, a]);
    const first = await repository.list({ spaceId, actorUserId: "stripe-owner" });
    const second = await repository.list({ spaceId, actorUserId: "stripe-owner", after: first.after });
    assert.equal(first.accounts.length, 50); assert.equal(second.accounts.length, 11); assert.equal(second.after, null);
    assert.equal(new Set([...first.accounts, ...second.accounts].map(account => account.id)).size, 61);
  });
});

integration("expand migration preserves the old writer, then adoption takes its latest verified envelope exactly once", async () => {
  const isolated = await isolatedPostgres("stripe_migration", { shard: true });
  const { client, session: database } = isolated;
  const sql = (text, values) => client.query(text, values);
  const spaceId = `stripe-legacy-${crypto.randomUUID()}`;
  try {
    await seed(sql, spaceId);
    await sql("DROP TABLE data.app_stripe_account_grants");
    const fields = { oauthToken: "legacy-access", oauthRefreshToken: "legacy-refresh", oauthExpiresAt: String(Date.now() + 3_600_000), stripeUserId: a };
    const envelope = await encryptSecretValue(material, `app-connection:${spaceId}:stripe`, "credentials", 7, JSON.stringify(fields));
    await sql(`INSERT INTO data.app_connector_credentials(connection_id,space_id,version,field_names_json,encrypted_value_json,updated_by,created_at,updated_at)
      VALUES ($1||':stripe',$1,7,$2::jsonb,$3::jsonb,'stripe-owner',now(),now())`, [spaceId, JSON.stringify(Object.keys(fields)), JSON.stringify(envelope)]);
    await sql(`INSERT INTO data.app_connector_oauth_installations(connection_id,space_id,provider_id,app_client_id,installation_id,credential_version,updated_at,grant_generation)
      VALUES ($1||':stripe',$1,'stripe',$2,$3,7,now(),gen_random_uuid())`, [spaceId, clientId, a]);
    await sql(await readFile(new URL("../migrations/0231_expand_stripe_account_grants.sql", import.meta.url), "utf8"));
    assert.equal((await sql("SELECT legacy_pending FROM data.app_stripe_account_grants")).rows[0].legacy_pending, true);
    assert.equal((await sql("SELECT count(*)::int AS n FROM data.app_connector_credentials")).rows[0].n, 1);
    // An old in-flight Hub refresh after expand is adopted from current binding evidence, not the stale copy.
    await new PostgresAppCredentialRepository(database, material).put({ requestId: crypto.randomUUID(), spaceId, providerId: "stripe",
      actorUserId: "hub:oauth-refresh", asHub: true, expectedVersion: 7,
      fields: { oauthToken: "latest-legacy-access" }, policy: { allowed: ["oauthToken"] }, at: new Date().toISOString() });
    const repository = new PostgresStripeAccountRepository(database, material);
    assert.equal((await repository.list({ spaceId, actorUserId: "stripe-owner" })).accounts[0].id, a);
    assert.equal((await repository.claimRefresh({ spaceId, accountId: a, appClientId: clientId })).grant.accessToken, "latest-legacy-access");
    assert.equal((await sql("SELECT count(*)::int AS n FROM data.app_connector_credentials")).rows[0].n, 0);
    assert.equal((await sql("SELECT count(*)::int AS n FROM data.app_connector_oauth_installations")).rows[0].n, 0);
    assert.equal((await repository.list({ spaceId, actorUserId: "stripe-owner" })).accounts.length, 1);
  } finally { await isolated.close(); }
});
