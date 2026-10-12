import { withProviderResponses as fetched } from "./fetch-responses.mjs";
import assert from "node:assert/strict";
import { exchangeOAuthGrant, oauthClient, oauthProviderIds } from "../../src/connectors/oauth.ts";
import { parseActionCommand } from "../../src/connectors/action-parse.ts";
import { getAppConnectorProvider } from "../../src/app-connectors.ts";

const company = { CONNECTOR_GOOGLE_CLIENT_ID: "fixture-client.apps.googleusercontent.com", CONNECTOR_GOOGLE_CLIENT_SECRET: "fixture-secret" };

/** Parse `@<provider>:<action>:<target> …` with the connector's own parser. */
export function statementParser(providerId, actions) {
  return body => {
    const command = parseActionCommand(providerId, body);
    return actions[command.actionId].parse(command.statement);
  };
}

/**
 * A read-only Google connector signs in with the company Google client, keeps a grant only when Google confirms
 * exactly its one scope, and declares every action as a read in its manifest.
 */
export async function assertReadOnlyGoogleGrant(providerId, scope, actions, { broader, refused }) {
  assert.ok(oauthProviderIds(company).includes(providerId));
  const client = oauthClient(company, providerId);
  assert.equal(client.clientId, company.CONNECTOR_GOOGLE_CLIENT_ID);
  const accepted = { access_token: "a", refresh_token: "r", token_type: "Bearer", expires_in: 3600, scope };
  assert.equal((await fetched([{ body: accepted }], () => exchangeOAuthGrant(client, "code", "https://hub.test/cb"))).result.fields.oauthToken, "a");
  for (const wrong of [broader, `${scope} https://www.googleapis.com/auth/webmasters`]) {
    await fetched([{ body: { ...accepted, scope: wrong } }], () => assert.rejects(exchangeOAuthGrant(client, "code", "https://hub.test/cb"), refused));
  }
  const manifest = getAppConnectorProvider(providerId);
  assert.deepEqual(manifest.oauth.scopes, [scope]);
  const effects = new Map(manifest.actions.map(action => [action.id, action.effect]));
  for (const [id, action] of Object.entries(actions)) assert.deepEqual([action.effect, effects.get(id)], ["read", "read"], id);
}
