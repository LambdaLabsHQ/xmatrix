import assert from "node:assert/strict";
import { Hono } from "hono";
import { ControlError, PostgresAppCredentialRepository } from "../../db/dist/index.js";
import { connectorDatabase, integration } from "../../db/test/postgres-database.fixture.mjs";
import { HUB_ROUTES } from "@xmatrix/protocol";
import * as oauth from "../src/connectors/oauth.ts";
import * as metering from "../src/usage-cost-metering.ts";
import { signGitHubAppState } from "../src/index-shared.ts";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { stubFetchResponses } from "./support/fetch-responses.mjs";

const load = await compileCommonJsSourceModule(new URL("../src/index-routes-connector-oauth.ts", import.meta.url));
const env = { CONNECTOR_NOTION_CLIENT_ID: "notion-app", CONNECTOR_NOTION_CLIENT_SECRET: "notion-secret",
  CONNECTOR_GMAIL_CLIENT_ID: "ac_gmail", CONNECTOR_COMPOSIO_API_KEY: "composio-key" };

async function withSpaces(run) {
  const { client, database, sql } = await connectorDatabase("oauth-space-authorization-test");
  const spaces = [0, 1].map(() => `oauth-authorization-${crypto.randomUUID()}`);
  const repository = new PostgresAppCredentialRepository(database, "test-encryption-key");
  const principal = { id: `oauth-admin-${crypto.randomUUID()}` };
  const imports = {
    "./connectors/oauth": oauth, "./usage-cost-metering": metering, "@xmatrix/protocol": { HUB_ROUTES },
    "@xmatrix/db": { ControlError },
    "./connectors/credentials": { connectorCredentialRepository: () => repository },
    "./index-shared": { requireAuth: async () => principal, requireHumanAuth: user => user,
      connectorHubOrigin: () => "https://hub.test",
      jsonErrors: async (context, work) => {
        try { return await work(); } catch (error) { return context.json({ error: error.code }, error.status ?? 500); }
      } },
    "./deployment-origins": { appOrigin: () => "https://xmatrix.test" },
    "./apps": { upsertAppConnection: () => assert.fail("a refused Connect cannot write a connection") },
  };
  const app = new Hono();
  load(name => imports[name] ?? {}).registerConnectorOAuthRoutes(app);
  const start = (spaceId, providerId) => app.request(`/api/spaces/${spaceId}/app-connections/${providerId}/oauth/start`,
    { method: "POST" }, env);
  const complete = state => app.request(HUB_ROUTES.connector_oauth_complete, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ state, code: "private-code" }) }, env);
  try {
    await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$3,'admin',1,now(),now()),($2,$3,'member',1,now(),now())`, [...spaces, principal.id]);
    await run({ spaces, sql, principal, start, complete });
  } finally {
    await sql("DELETE FROM data.space_deletions WHERE space_id=ANY($1::text[])", [spaces]);
    await sql("DELETE FROM data.space_members WHERE space_id=ANY($1::text[])", [spaces]);
    await database.close?.();
    await client.end();
  }
}

// The credential-store tests prove write authorization, but cannot catch an
// OAuth route that contacts the provider before that write. Exercise the real
// routes with live PostgreSQL roles and observe the external-call boundary.
integration("OAuth start requires admin authority in the target Space before signing state or creating a Composio account", async () => {
  await withSpaces(async ({ spaces, start }) => {
    const provider = stubFetchResponses([{ body: { redirect_url: "https://connect.composio.dev/link/fixture" } }]);
    try {
      const allowed = await start(spaces[0], "notion");
      assert.equal(allowed.status, 200);
      const state = new URL((await allowed.json()).url).searchParams.get("state");
      assert.equal((await oauth.verifyOAuthState(env, state)).spaceId, spaces[0]);
      for (const spaceId of [spaces[1], `absent-${crypto.randomUUID()}`]) {
        for (const providerId of ["notion", "gmail"]) {
          assert.equal((await start(spaceId, providerId)).status, 404, `${providerId}: another Space's admin has no authority here`);
        }
      }
      assert.equal(provider.calls.length, 0, "refused starts create no external account");
      assert.equal((await start(spaces[0], "gmail")).status, 200);
      assert.equal(provider.calls.length, 1, "an authorized Composio start still works");
    } finally { provider.restore(); }
  });
});

integration("OAuth completion rechecks current target-Space authority before exchanging any grant", async () => {
  await withSpaces(async ({ spaces, sql, principal, complete }) => {
    // Retain state issued while this person was still an admin.
    const states = await Promise.all(["notion", "gmail"].map(async providerId => [providerId,
      await signGitHubAppState({ providerId, spaceId: spaces[0], userId: principal.id,
        nonce: crypto.randomUUID(), expiresAt: Date.now() + 60_000 }, oauth.oauthClient(env, providerId).clientSecret)]));
    const provider = stubFetchResponses([]);
    try {
      for (const role of ["member", "viewer", null, "deleting"]) {
        await sql("DELETE FROM data.space_members WHERE space_id=$1 AND user_id=$2", [spaces[0], principal.id]);
        if (role) await sql(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
          VALUES ($1,$2,$3,1,now(),now())`, [spaces[0], principal.id, role === "deleting" ? "admin" : role]);
        if (role === "deleting") await sql(`INSERT INTO data.space_deletions
          (space_id,space_name,owner_user_id,requested_at,purge_after,state,members_json,automations_json,version,updated_at)
          VALUES ($1,'test',$2,now(),now()+interval '1 day','scheduled','[]','[]',1,now())`, [spaces[0], principal.id]);
        for (const [providerId, state] of states) {
          const response = await complete(state);
          assert.equal(response.status, 200);
          assert.match((await response.json()).redirect, /oauth=failed/u);
          assert.equal(provider.calls.length, 0, `${providerId}: ${role} cannot exchange an earlier grant`);
        }
      }
    } finally { provider.restore(); }
  });
});
