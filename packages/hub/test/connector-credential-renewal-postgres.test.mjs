import assert from "node:assert/strict";
import { PostgresAppCredentialRepository } from "@xmatrix/db";
import { connectionString, connectorDatabase, integration } from "../../db/test/postgres-database.fixture.mjs";
import { connectionCredentialGrant, credentialRenewal } from "../src/connectors/connection-credentials.ts";

/* What an action saves back for its connection (rotated cookies, a number read from the provider) is the Hub's own
   write: it must apply to the credentials the action read, follow its own earlier saves, and never undo an admin's. */

const PROVIDER = "appstoreconnect";
const policy = { allowed: ["issuerId", "keyId", "privateKey", "webhookSecret", "vendorNumber", "webSession"] };

async function withConnection(run) {
  const { client, database, sql } = await connectorDatabase("credential-renewal-test");
  const space = `credential-renewal-${crypto.randomUUID()}`;
  const material = "credential-renewal-encryption-test-material";
  const store = new PostgresAppCredentialRepository(database, material);
  const env = { RELAY_POSTGRES: { connectionString }, RELAY_POSTGRES_SHARD_ID: "shard-0", XMATRIX_SECRET_CATALOG_KEY: material };
  const read = async () => store.resolve({ requestId: crypto.randomUUID(), spaceId: space, providerId: PROVIDER });
  const adminSave = fields => store.put({ requestId: crypto.randomUUID(), spaceId: space, providerId: PROVIDER,
    actorUserId: "owner", fields, policy, at: new Date().toISOString() });
  try {
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,'owner','owner',1,now(),now())`, [space]);
    await sql(`INSERT INTO data.app_connector_connections
      (space_id,connection_id,version,provider_id,provider_name,status,auth_mode,scopes_json,secret_refs_json,
       capabilities_json,channel_ids_json,created_by,search_rank_sequence,created_at,updated_at)
      VALUES ($1,$1||':'||$2,1,$2,'App Store Connect','configured','api-token','[]','[]','[]','[]','owner',$1||':rank',
        now()-interval '1 second',now()-interval '1 second')`, [space, PROVIDER]);
    await adminSave({ keyId: "2X9R4HXF34", privateKey: "key", webSession: "myacinfo=first" });
    await run({ env, space, read, adminSave, store });
  } finally {
    for (const table of ["app_connector_credentials", "app_connector_connections", "space_members"]) {
      await sql(`DELETE FROM data.${table} WHERE space_id=$1`, [space]);
    }
    await database.close?.();
    await client.end();
  }
}

integration("an action's renewals save against the version it read, one after another", async () => {
  await withConnection(async ({ env, space, read }) => {
    const grant = await connectionCredentialGrant(env, space, PROVIDER);
    assert.equal(grant.values.webSession, "myacinfo=first");
    const save = credentialRenewal(env, space, PROVIDER, grant.version);
    await save({ vendorNumber: "87654321" });
    await save({ webSession: "myacinfo=rotated" });
    const saved = await read();
    assert.equal(saved.values.vendorNumber, "87654321");
    assert.equal(saved.values.webSession, "myacinfo=rotated", "the second save follows the first");
    assert.equal(saved.values.keyId, "2X9R4HXF34", "fields the action did not renew are kept");
    assert.equal(saved.version, grant.version + 2);
  });
});

integration("a renewal never overwrites what a Space admin saved after the action read its credentials", async () => {
  await withConnection(async ({ env, space, read, adminSave }) => {
    const grant = await connectionCredentialGrant(env, space, PROVIDER);
    await adminSave({ webSession: "myacinfo=admin" });
    const save = credentialRenewal(env, space, PROVIDER, grant.version);
    await assert.rejects(save({ webSession: "myacinfo=stale" }), error => error.code === "credential_changed");
    assert.equal((await read()).values.webSession, "myacinfo=admin");
  });
});

integration("a Hub write that names no version is refused, which is why renewals carry one", async () => {
  await withConnection(async ({ space, store }) => {
    await assert.rejects(store.put({ requestId: crypto.randomUUID(), spaceId: space, providerId: PROVIDER,
      actorUserId: "hub:provider-renewal", fields: { vendorNumber: "1" }, policy, at: new Date().toISOString(), asHub: true }),
    error => error.code === "credential_changed");
  });
});
