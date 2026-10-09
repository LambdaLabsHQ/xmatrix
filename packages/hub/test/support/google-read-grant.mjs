import assert from "node:assert/strict";
import { withProviderResponses as fetched } from "./fetch-responses.mjs";
import { exchangeOAuthGrant, oauthClient, oauthProviderIds } from "../../src/connectors/oauth.ts";
import { getAppConnectorProvider } from "../../src/app-connectors.ts";

const company = { CONNECTOR_GOOGLE_CLIENT_ID: "fixture-client.apps.googleusercontent.com", CONNECTOR_GOOGLE_CLIENT_SECRET: "fixture-secret" };

/**
 * A read-only Google connector signs in with the company Google client, keeps
 * exactly its one scope (every `wider` grant is refused with `refusal`), and
 * every Hub action is a read in the manifest too.
 */
export async function assertGoogleReadOnlyGrant(providerId, scope, wider, refusal, actions) {
  const client = oauthClient(company, providerId);
  assert.equal(client.clientId, company.CONNECTOR_GOOGLE_CLIENT_ID);
  assert.ok(oauthProviderIds(company).includes(providerId));
  const accepted = { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 3600, scope };
  assert.equal((await fetched([{ body: accepted }], () => exchangeOAuthGrant(client, "code", "https://hub.test/cb"))).result.fields.oauthToken, "a");
  for (const other of wider) {
    await fetched([{ body: { ...accepted, scope: other } }], () => assert.rejects(exchangeOAuthGrant(client, "code", "https://hub.test/cb"), refusal));
  }
  const manifest = getAppConnectorProvider(providerId);
  assert.deepEqual(manifest.oauth.scopes, [scope]);
  const effects = new Map(manifest.actions.map(action => [action.id, action.effect]));
  for (const [id, action] of Object.entries(actions)) assert.deepEqual([action.effect, effects.get(id)], ["read", "read"], id);
}
