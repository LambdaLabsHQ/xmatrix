import assert from "node:assert/strict";
import { DatabaseCommitUnknownError, PostgresAppCredentialRepository } from "@xmatrix/db";
import { connectionString, connectorDatabase, integration } from "../../db/test/postgres-database.fixture.mjs";
import { oauthClient } from "../src/connectors/oauth.ts";
import { connectXAccount, parseXAccounts, xAccountFields } from "../src/connectors/x-accounts.ts";
import { refreshXAccount } from "../src/connectors/x-api.ts";
import { stubFetchResponses } from "./support/fetch-responses.mjs";

const client = oauthClient({ CONNECTOR_X_CLIENT_ID: "company-app", CONNECTOR_X_CLIENT_SECRET: "test-client-secret" }, "x");
const policy = { allowed: ["accounts"] };
const view = ({ id, username, generation }) => ({ id, username, generation });
const remoteTokens = id => ({ access_token: `rotated-access-${id}`, refresh_token: `rotated-refresh-${id}`,
  token_type: "bearer", expires_in: 7200 });

async function withDatabase(run, { empty = false } = {}) {
  const { client: sqlClient, database, sql } = await connectorDatabase("x-refresh-test");
  const space = `x-refresh-${crypto.randomUUID()}`;
  const accounts = ["101", "202"].map((id, index) => ({ id, username: index ? "personal" : "company",
    generation: crypto.randomUUID(), ownerUserId: "owner", clientId: client.clientId,
    accessToken: `initial-access-${id}`, refreshToken: `initial-refresh-${id}`, expiresAt: Date.now() - 1000,
    scopes: client.manifest.oauth.scopes.join(" ") }));
  const material = "x-refresh-encryption-test-material";
  const store = new PostgresAppCredentialRepository(database, material);
  const write = values => store.put({ requestId: crypto.randomUUID(), spaceId: space, providerId: "x", actorUserId: "owner",
    fields: xAccountFields(values), policy, at: new Date().toISOString() });
  const read = async () => parseXAccounts((await store.resolve({ requestId: crypto.randomUUID(),
    spaceId: space, providerId: "x" }))?.values.accounts);
  const snapshot = () => store.installationSnapshot({ requestId: crypto.randomUUID(), spaceId: space,
    actorUserId: "owner", providerId: "x" });
  const env = { RELAY_POSTGRES: { connectionString }, RELAY_POSTGRES_SHARD_ID: "shard-0", XMATRIX_SECRET_CATALOG_KEY: material };
  try {
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,'owner','owner',1,now(),now())`, [space]);
    await sql(`INSERT INTO data.app_connector_connections
      (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
       capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES ($1,$1||':x',1,'x','X','configured','oauth','[]','[]','[]','[]','owner',$1||':rank',
        now()-interval '1 second',now()-interval '1 second')`, [space]);
    if (!empty) await write(accounts);
    await run({ space, store, sql, accounts, read, write, snapshot, env });
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

integration("X confirmed remote token pairs survive repeated transient database failures without another rotation", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    let confirmed = false, readFailures = 0, saveAttempts = 0;
    const provider = stubFetchResponses([{ body: remoteTokens("101") }], {
      reply(response) { confirmed = true; return Response.json(response.body); },
    });
    const store = {
      resolve: async input => {
        if (confirmed && readFailures++ === 0) throw Object.assign(new Error("test read connection reset"), { code: "ECONNRESET" });
        return f.store.resolve(input);
      },
      put: async input => {
        if (confirmed) {
          const code = ["08006", "ECONNRESET", "40001", "40P01"][saveAttempts++];
          if (code) throw Object.assign(new Error("test transient save failure"), { code });
        }
        return f.store.put(input);
      },
    };
    try {
      const refreshed = await refreshXAccount(store, f.space, client, view(f.accounts[0]));
      assert.equal(saveAttempts, 5, "the confirmed pair stays in memory across more than three failed saves");
      assert.equal(provider.calls.length, 1);
      assert.equal(refreshed.refreshToken, "rotated-refresh-101");
      assert.equal(Object.hasOwn(refreshed, "refreshing"), false);
      assert.deepEqual(await f.read(), [refreshed, f.accounts[1]]);
    } finally { provider.restore(); }
  });
});

integration("X reconciles a lost database commit receipt for a confirmed pair without restoring the refresh lease", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    let confirmed = false, saves = 0;
    const provider = stubFetchResponses([{ body: remoteTokens("101") }], {
      reply(response) { confirmed = true; return Response.json(response.body); },
    });
    const store = { resolve: input => f.store.resolve(input), put: async input => {
      const result = await f.store.put(input);
      if (confirmed && saves++ === 0) throw new DatabaseCommitUnknownError("08006");
      return result;
    } };
    try {
      const refreshed = await refreshXAccount(store, f.space, client, view(f.accounts[0]));
      assert.equal(provider.calls.length, 1);
      assert.equal(saves, 1, "rereading the saved pair confirms the uncertain commit without another write");
      assert.equal(refreshed.refreshToken, "rotated-refresh-101");
      assert.equal(Object.hasOwn(refreshed, "refreshing"), false);
      assert.deepEqual(await f.read(), [refreshed, f.accounts[1]]);
    } finally { provider.restore(); }
  });
});

integration("X stops after eight local save failures and keeps an unconfirmed grant fenced without rotating again", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    let confirmed = false, saveAttempts = 0;
    const provider = stubFetchResponses([{ body: remoteTokens("101") }], {
      reply(response) { confirmed = true; return Response.json(response.body); },
    });
    const store = { resolve: input => f.store.resolve(input), put: async input => {
      if (confirmed) {
        saveAttempts++;
        throw Object.assign(new Error("test persistent connection failure"), { code: "08006" });
      }
      return f.store.put(input);
    } };
    try {
      await assert.rejects(refreshXAccount(store, f.space, client, view(f.accounts[0])), error => error.code === "08006");
      assert.equal(saveAttempts, 8);
      assert.equal(provider.calls.length, 1);
      const saved = await f.read();
      assert.equal(saved[0].refreshToken, "initial-refresh-101");
      assert.match(saved[0].refreshing, /^[a-f0-9-]{36}$/u);
      await assert.rejects(refreshXAccount(f.store, f.space, client, view(f.accounts[0])), /refreshing/u);
      assert.equal(provider.calls.length, 1);
      assert.deepEqual(saved[1], f.accounts[1]);
    } finally { provider.restore(); }
  });
});

integration("X callback merges against the latest grant after another account refreshed during OAuth", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    const snapshot = await f.snapshot();
    const incoming = { ...f.accounts[0], id: "303", username: "another", generation: crypto.randomUUID(),
      accessToken: "oauth-new-access", refreshToken: "oauth-new-refresh", expiresAt: Date.now() + 7_200_000 };
    const provider = stubFetchResponses([{ body: remoteTokens("202") }]);
    try {
      const refreshed = await refreshXAccount(f.store, f.space, client, view(f.accounts[1]));
      const latest = await f.snapshot();
      assert.equal(latest.connectionVersion, snapshot.connectionVersion);
      assert.ok(latest.credentialVersion > snapshot.credentialVersion);
      await connectXAccount(f.env, { spaceId: f.space, actorUserId: "owner", fields: xAccountFields([incoming]), snapshot });
      assert.deepEqual(await f.read(), [f.accounts[0], refreshed, incoming]);
      assert.equal(provider.calls.length, 1);
    } finally { provider.restore(); }
  });
});

integration("X callback retries a real credential CAS conflict while preserving another account's concurrent token update", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    const snapshot = await f.snapshot();
    const incoming = { ...f.accounts[0], id: "303", username: "another", generation: crypto.randomUUID() };
    const other = { ...f.accounts[1], accessToken: "concurrent-access-202", refreshToken: "concurrent-refresh-202" };
    const originalPut = PostgresAppCredentialRepository.prototype.put;
    let callbackWrites = 0;
    PostgresAppCredentialRepository.prototype.put = async function (input) {
      if (input.spaceId === f.space && !input.asHub && callbackWrites++ === 0) {
        const stored = await f.store.resolve({ requestId: crypto.randomUUID(), spaceId: f.space, providerId: "x" });
        await originalPut.call(f.store, { requestId: crypto.randomUUID(), spaceId: f.space, providerId: "x",
          actorUserId: "hub:x-token-refresh", asHub: true, expectedVersion: stored.version, expectedGrant: stored,
          fields: xAccountFields([f.accounts[0], other]), policy, at: new Date().toISOString() });
      }
      return originalPut.call(this, input);
    };
    try {
      await connectXAccount(f.env, { spaceId: f.space, actorUserId: "owner", fields: xAccountFields([incoming]), snapshot });
      assert.equal(callbackWrites, 2, "the competing real PostgreSQL writer makes the first CAS stale");
      assert.deepEqual(await f.read(), [f.accounts[0], other, incoming]);
    } finally { PostgresAppCredentialRepository.prototype.put = originalPut; }
  });
});

integration("X callback confirms its exact committed grant after a lost COMMIT acknowledgement", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    const snapshot = await f.snapshot();
    const incoming = { ...f.accounts[0], id: "303", username: "another", generation: crypto.randomUUID(),
      accessToken: "oauth-new-access", refreshToken: "oauth-new-refresh" };
    const originalPut = PostgresAppCredentialRepository.prototype.put;
    let callbackWrites = 0;
    PostgresAppCredentialRepository.prototype.put = async function (input) {
      const result = await originalPut.call(this, input);
      if (input.spaceId === f.space && !input.asHub && callbackWrites++ === 0) throw new DatabaseCommitUnknownError("08006");
      return result;
    };
    try {
      await connectXAccount(f.env, { spaceId: f.space, actorUserId: "owner", fields: xAccountFields([incoming]), snapshot });
      assert.equal(callbackWrites, 1, "the stored account generation and exact token pair prove the first commit succeeded");
      assert.equal((await f.snapshot()).connectionVersion, snapshot.connectionVersion + 1);
      assert.deepEqual(await f.read(), [...f.accounts, incoming]);
    } finally { PostgresAppCredentialRepository.prototype.put = originalPut; }
  });
});

integration("X callback still rejects Human edits or a recreated connection during OAuth", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    const snapshot = await f.snapshot();
    const incoming = { ...f.accounts[0], generation: crypto.randomUUID() };
    await f.write(f.accounts);
    await assert.rejects(connectXAccount(f.env, { spaceId: f.space, actorUserId: "owner", fields: xAccountFields([incoming]), snapshot }),
      error => error.status === 409);
    const currentSnapshot = await f.snapshot();
    await f.sql("UPDATE data.app_connector_connections SET search_rank_sequence=$2 WHERE space_id=$1", [f.space, crypto.randomUUID()]);
    await assert.rejects(connectXAccount(f.env, { spaceId: f.space, actorUserId: "owner", fields: xAccountFields([incoming]), snapshot: currentSnapshot }),
      error => error.status === 409);
    assert.deepEqual(await f.read(), f.accounts);
  });
});

integration("X first callback uses an installation snapshot when no credential envelope exists", { timeout: 30_000 }, async () => {
  await withDatabase(async f => {
    const snapshot = await f.snapshot();
    assert.equal(snapshot.credentialVersion, 0);
    await connectXAccount(f.env, { spaceId: f.space, actorUserId: "owner", fields: xAccountFields([f.accounts[0]]), snapshot });
    assert.deepEqual(await f.read(), [f.accounts[0]]);
  }, { empty: true });
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
    let released = false, readsAfterProvider = 0;
    const store = { resolve: input => {
      if (released) readsAfterProvider++;
      return f.store.resolve(input);
    }, put: input => f.store.put(input) };
    const first = refreshXAccount(store, f.space, client, view(f.accounts[0]));
    try {
      await providerEntered(provider, [first]);
      const reconnected = { ...f.accounts[0], generation: crypto.randomUUID(), accessToken: "reconnected-access-101",
        refreshToken: "reconnected-refresh-101", expiresAt: Date.now() + 7_200_000 };
      await f.write([reconnected, f.accounts[1]]);
      released = true; provider.release();
      await assert.rejects(first, /disconnected or reconnected/u);
      assert.equal(readsAfterProvider, 1, "a replaced generation is an invariant refusal, not a transient retry");
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
