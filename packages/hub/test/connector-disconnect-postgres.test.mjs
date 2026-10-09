import assert from "node:assert/strict";
import { connectorDatabase, integration } from "../../db/test/postgres-database.fixture.mjs";
import { AppControlError, PostgresAppCredentialRepository, PostgresAppRepository } from "../../db/dist/index.js";
import { getAppConnectorProvider } from "../src/app-connectors.ts";
import { grantFieldsForgottenOnDisconnect, oauthClient } from "../src/connectors/oauth.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";

const load = await compileCommonJsSourceModule(new URL("../src/connectors/forget-grant.ts", import.meta.url));
const at = "2026-10-09T00:00:00.000Z";
const policy = { allowed: ["composioAccountId"] };

async function withGrant(run) {
  const { client, database, sql } = await connectorDatabase("connector-disconnect-test");
  const spaceId = `disconnect-${crypto.randomUUID()}`;
  const repository = new PostgresAppCredentialRepository(database, "test-secret-catalog-key");
  const input = { spaceId, providerId: "gmail", actorUserId: "owner" };
  const write = accountId => repository.put({ requestId: crypto.randomUUID(), ...input,
    fields: { composioAccountId: accountId }, policy, at });
  const read = () => repository.resolve({ requestId: crypto.randomUUID(), spaceId, providerId: "gmail" });
  const effects = [];
  let deleting = async () => {};
  const dependencies = {
    "../app-connectors": { getAppConnectorProvider },
    "./credentials": { connectorCredentialRepository: () => repository },
    "./oauth": { grantFieldsForgottenOnDisconnect, oauthClient },
    "./composio": { deleteComposioAccount: async (key, id) => { effects.push([key, id]); await deleting(); } },
  };
  const { forgetConnectionGrant } = load(name => {
    assert.ok(dependencies[name], name);
    return dependencies[name];
  });
  const env = { CONNECTOR_GMAIL_CLIENT_ID: "ac_gmail", CONNECTOR_COMPOSIO_API_KEY: "project-key" };
  const disconnect = actorUserId => forgetConnectionGrant(env, { ...input, actorUserId });
  try {
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,'owner','owner',1,$2,$2),($1,'member','member',1,$2,$2),($1,'viewer','viewer',1,$2,$2)`, [spaceId, at]);
    await sql(`INSERT INTO data.app_connector_connections
      (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
       capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES ($1,$1||':gmail',1,'gmail','Gmail','configured','oauth','[]','[]','[]','[]','owner',$1||':rank', $2,$2)`, [spaceId, at]);
    await write("ca_original");
    await run({ sql, spaceId, database, effects, read, write, disconnect,
      onDelete: callback => { deleting = callback; } });
  } finally {
    for (const table of ["space_deletions", "app_connector_credentials", "app_connector_connections", "space_members"]) {
      await sql(`DELETE FROM data.${table} WHERE space_id=$1`, [spaceId]);
    }
    await database.close?.();
    await client.end();
  }
}

integration("disconnect proves current admin authority before deleting an external grant", async () => {
  await withGrant(async ({ sql, spaceId, database, disconnect, effects, read }) => {
    const apps = new PostgresAppRepository(database);
    assert.ok((await apps.getConnection({ requestId: "member-read", connectionId: `${spaceId}:gmail`,
      actorUserId: "member" })).connection, "a member may see the connection without being allowed to disconnect it");
    for (const actor of ["member", "viewer", "outsider"]) {
      await assert.rejects(disconnect(actor), error => error instanceof AppControlError && error.status === 404);
    }
    await sql("UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id='owner'", [spaceId]);
    await assert.rejects(disconnect("owner"), error => error instanceof AppControlError && error.status === 404);
    assert.deepEqual(effects, [], "no provider deletion precedes authorization");
    assert.equal((await read()).values.composioAccountId, "ca_original");
    await sql("UPDATE data.space_members SET role='admin' WHERE space_id=$1 AND user_id='owner'", [spaceId]);
    await sql(`INSERT INTO data.space_deletions(space_id,space_name,owner_user_id,requested_at,purge_after,state,
      members_json,automations_json,version,updated_at) VALUES($1,'test','owner',$2,$2::timestamptz+interval '1 day',
      'scheduled','[]','[]',1,$2)`, [spaceId, at]);
    await assert.rejects(disconnect("owner"), error => error instanceof AppControlError && error.status === 404);
    assert.deepEqual(effects, [], "a scheduled Space deletion removes disconnect authority too");
    await sql("DELETE FROM data.space_deletions WHERE space_id=$1", [spaceId]);
    await disconnect("owner");
    assert.deepEqual(effects, [["project-key", "ca_original"]]);
    assert.equal(await read(), null);
  });
});

integration("disconnect cannot clear a recreated grant whose credential version repeats", async () => {
  await withGrant(async ({ disconnect, read, write, onDelete }) => {
    const original = await read();
    onDelete(async () => { await write(null); await write("ca_recreated"); });
    await assert.rejects(disconnect("owner"), error => error instanceof AppControlError && error.status === 409);
    const fresh = await read();
    assert.equal(fresh.version, original.version, "credential deletion resets its counter");
    assert.equal(fresh.values.composioAccountId, "ca_recreated");
  });
});

integration("disconnect preserves the stored grant on provider failure and a new grant during deletion", async () => {
  await withGrant(async ({ disconnect, effects, read, write, onDelete }) => {
    onDelete(async () => { throw new Error("provider unavailable"); });
    await assert.rejects(disconnect("owner"), /provider unavailable/u);
    assert.equal((await read()).values.composioAccountId, "ca_original", "failed retirement remains retryable");
    onDelete(async () => { await write("ca_reconnected"); });
    await assert.rejects(disconnect("owner"), error => error instanceof AppControlError && error.status === 409);
    assert.equal((await read()).values.composioAccountId, "ca_reconnected", "an old disconnect cannot clear a new grant");
    assert.deepEqual(effects, [["project-key", "ca_original"], ["project-key", "ca_original"]]);
    onDelete(async () => {});
    await disconnect("owner");
    assert.equal(await read(), null);
  });
});
