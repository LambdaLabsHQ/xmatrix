import assert from "node:assert/strict";
import { PostgresAppCredentialRepository } from "@xmatrix/db";
import { connectorDatabase, integration } from "../../db/test/postgres-database.fixture.mjs";
import { oauthClient } from "../src/connectors/oauth.ts";
import { parseXAccounts, xAccountFields } from "../src/connectors/x-accounts.ts";
import { refreshXAccount } from "../src/connectors/x-api.ts";
import { stubFetchResponses } from "./support/fetch-responses.mjs";

const client = oauthClient({ CONNECTOR_X_CLIENT_ID: "company-app", CONNECTOR_X_CLIENT_SECRET: "test-client-secret" }, "x");
const policy = { allowed: ["accounts"] };
const view = ({ id, username, generation }) => ({ id, username, generation });
const remoteTokens = id => ({ access_token: `rotated-access-${id}`, refresh_token: `rotated-refresh-${id}`,
  token_type: "bearer", expires_in: 7200 });

async function withDatabase(run) {
  const { client: sqlClient, database, sql } = await connectorDatabase("x-refresh-test");
  const space = `x-refresh-${crypto.randomUUID()}`;
  const accounts = ["101", "202"].map((id, index) => ({ id, username: index ? "personal" : "company",
    generation: crypto.randomUUID(), ownerUserId: "owner", clientId: client.clientId,
    accessToken: `initial-access-${id}`, refreshToken: `initial-refresh-${id}`, expiresAt: Date.now() - 1000,
    scopes: client.manifest.oauth.scopes.join(" ") }));
  const store = new PostgresAppCredentialRepository(database, "x-refresh-encryption-test-material");
  const write = values => store.put({ requestId: crypto.randomUUID(), spaceId: space, providerId: "x", actorUserId: "owner",
    fields: xAccountFields(values), policy, at: new Date().toISOString() });
  const read = async () => parseXAccounts((await store.resolve({ requestId: crypto.randomUUID(),
    spaceId: space, providerId: "x" })).values.accounts);
  try {
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,'owner','owner',1,now(),now())`, [space]);
    await sql(`INSERT INTO data.app_connector_connections
      (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
       capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES ($1,$1||':x',1,'x','X','configured','oauth','[]','[]','[]','[]','owner',$1||':rank',now(),now())`, [space]);
    await write(accounts);
    await run({ space, store, sql, accounts, read, write });
  } finally {
    for (const table of ["app_connector_credentials", "app_connector_connections", "space_members"]) {
      await sql(`DELETE FROM data.${table} WHERE space_id=$1`, [space]);
    }
    await database.close?.();
    await sqlClient.end();
  }
}

function gatedProvider(tokens) {
  const release = Promise.withResolvers(), entered = Promise.withResolvers(), firstEntered = Promise.withResolvers();
  let arrivals = 0;
  const fetch = stubFetchResponses(tokens.map(body => ({ body })), {
    decodeBody: body => body instanceof URLSearchParams ? Object.fromEntries(body) : body,
    async reply(response) {
      arrivals += 1;
      if (arrivals === 1) firstEntered.resolve();
      if (arrivals === tokens.length) entered.resolve();
      await release.promise;
      return Response.json(response.body);
    },
  });
  return { ...fetch, entered: entered.promise, firstEntered: firstEntered.promise, release: () => release.resolve() };
}

async function providerEntered(provider, operations, entered = provider.entered) {
  await Promise.race([entered, ...operations.map(operation => operation.then(
    () => { throw new Error("Refresh completed before reaching the gated provider"); }, error => { throw error; }))]);
  for (const call of provider.calls) {
    assert.equal(call.url, "https://api.x.com/2/oauth2/token");
    assert.equal(call.method, "POST");
    assert.equal(call.body.grant_type, "refresh_token");
    assert.equal(call.headers.get("authorization"), `Basic ${btoa("company-app:test-client-secret")}`);
  }
}

// This combines the real encrypted PostgreSQL CAS writer with remote rotation.
// OAuth parsing tests cannot prove that rivals claim one durable lease, or that
// a late provider result cannot resurrect a newer OAuth generation.
integration("X concurrent refresh claims one durable lease before exactly one remote rotation", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    const provider = gatedProvider([remoteTokens("101")]);
    const first = refreshXAccount(f.store, f.space, client, view(f.accounts[0]));
    try {
      await providerEntered(provider, [first]);
      const claimed = await f.read();
      assert.match(claimed[0].refreshing, /^[a-f0-9-]{36}$/u);
      assert.equal(claimed[0].accessToken, "initial-access-101");
      assert.equal(claimed[0].refreshToken, "initial-refresh-101");
      await assert.rejects(refreshXAccount(f.store, f.space, client, view(f.accounts[0])), /refreshing|grant changed/u);
      assert.equal(provider.calls.length, 1, "a rival cannot rotate an already leased refresh token");
      assert.equal(provider.calls[0].body.refresh_token, "initial-refresh-101");
      provider.release();
      const refreshed = await first;
      assert.equal(refreshed.accessToken, "rotated-access-101");
      assert.equal(refreshed.refreshToken, "rotated-refresh-101");
      assert.equal(Object.hasOwn(refreshed, "refreshing"), false);
      const saved = await f.read();
      assert.deepEqual(saved[0], refreshed);
      assert.deepEqual(saved[1], f.accounts[1], "refreshing one account preserves the other's complete grant");
      assert.ok(saved[0].expiresAt > Date.now() + 7_000_000);
      const rows = await f.sql("SELECT encrypted_value_json FROM data.app_connector_credentials WHERE space_id=$1", [f.space]);
      assert.doesNotMatch(JSON.stringify(rows.rows), /rotated-access|rotated-refresh|initial-refresh/u);
    } finally {
      provider.release();
      await Promise.allSettled([first]);
      provider.restore();
    }
  });
});

integration("X uncertain refresh response preserves its durable lease and never blindly retries remote rotation", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    const provider = stubFetchResponses([{ error: new DOMException("provider response timed out after rotation", "TimeoutError") }], {
      reply(response) { throw response.error; },
    });
    try {
      await assert.rejects(refreshXAccount(f.store, f.space, client, view(f.accounts[0])), /timed out after rotation/u);
      const saved = await f.read();
      assert.equal(saved[0].refreshToken, "initial-refresh-101");
      assert.match(saved[0].refreshing, /^[a-f0-9-]{36}$/u);
      assert.ok(Number.isSafeInteger(saved[0].refreshStartedAt));
      await assert.rejects(refreshXAccount(f.store, f.space, client, view(f.accounts[0])), /refreshing/u);
      assert.equal(provider.calls.length, 1);
      assert.deepEqual(saved[1], f.accounts[1]);
    } finally { provider.restore(); }
  });
});

integration("X reconnect replaces an in-flight grant and a late rotated pair cannot resurrect its old generation", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    const provider = gatedProvider([remoteTokens("old-101")]);
    const first = refreshXAccount(f.store, f.space, client, view(f.accounts[0]));
    try {
      await providerEntered(provider, [first]);
      const reconnected = { ...f.accounts[0], generation: crypto.randomUUID(), accessToken: "reconnected-access-101",
        refreshToken: "reconnected-refresh-101", expiresAt: Date.now() + 7_200_000 };
      await f.write([reconnected, f.accounts[1]]);
      provider.release();
      await assert.rejects(first, /disconnected or reconnected/u);
      assert.deepEqual(await f.read(), [reconnected, f.accounts[1]]);
      assert.equal(provider.calls.length, 1, "a reconnect conflict cannot retry the old provider grant");
    } finally {
      provider.release();
      await Promise.allSettled([first]);
      provider.restore();
    }
  });
});

integration("X concurrent different-account refreshes preserve both newly rotated token pairs", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    const provider = gatedProvider([remoteTokens("101"), remoteTokens("202")]);
    const operations = [];
    try {
      operations.push(refreshXAccount(f.store, f.space, client, view(f.accounts[0])));
      await providerEntered(provider, operations, provider.firstEntered);
      operations.push(refreshXAccount(f.store, f.space, client, view(f.accounts[1])));
      await providerEntered(provider, operations);
      assert.equal((await f.read()).filter(account => account.refreshing).length, 2);
      provider.release();
      await Promise.all(operations);
      const saved = await f.read();
      for (const [index, account] of saved.entries()) {
        assert.equal(account.accessToken, `rotated-access-${f.accounts[index].id}`);
        assert.equal(account.refreshToken, `rotated-refresh-${f.accounts[index].id}`);
        assert.equal(Object.hasOwn(account, "refreshing"), false);
        assert.equal(account.generation, f.accounts[index].generation);
      }
      assert.equal(provider.calls.length, 2);
    } finally {
      provider.release();
      await Promise.allSettled(operations);
      provider.restore();
    }
  });
});
