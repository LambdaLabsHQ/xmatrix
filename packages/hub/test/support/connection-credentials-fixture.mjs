import assert from "node:assert/strict";
import { compileCommonJsSourceModule } from "./commonjs-source-module.mjs";
import { getAppConnectorProvider } from "../../src/app-connectors.ts";
import { verifyNotion } from "../../src/connectors/actions/notion.ts";
import { ProviderRequestError } from "../../src/connectors/http.ts";
import { refreshOAuthFields } from "../../src/connectors/oauth.ts";
import { stubFetchResponses } from "./fetch-responses.mjs";

const load = await compileCommonJsSourceModule(new URL("../../src/connectors/connection-credentials.ts", import.meta.url));

/** Run the actual credential orchestrator with a scoped repository, without a database shortcut. */
export function credentialExecutor(repository) {
  const dependencies = {
    "../app-connectors": { getAppConnectorProvider },
    "./credentials": { connectorCredentialRepository: () => repository },
    "./actions/notion": { verifyNotion }, "./http": { ProviderRequestError }, "./oauth": { refreshOAuthFields },
  };
  const exports = load(name => { assert.ok(dependencies[name], name); return dependencies[name]; }, { crypto, Date, Object });
  return exports.connectionCredentials;
}

/** Observe the real refresh orchestrator's persistence and provider order. */
export async function runRefreshedAction({ env, providerId, credentials, response, action,
  conflict = false, status = 200, decodeBody = body => body }) {
  const effects = [], puts = [];
  const repository = {
    resolve: async () => ({ values: credentials, version: 4 }),
    put: async input => {
      puts.push(input);
      effects.push("persist");
      if (conflict) throw new Error("credentials changed during refresh");
    },
  };
  const fetches = stubFetchResponses([{ body: response }, { body: {}, status }], { decodeBody,
    reply: next => {
      effects.push("fetch");
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    },
  });
  let error;
  try { await action(await credentialExecutor(repository)(env, "fixture-space", providerId)); }
  catch (failure) { error = failure; }
  finally { fetches.restore(); }
  return { error, effects, puts, calls: fetches.calls };
}

export function assertSavedRotation(result, token, refresh) {
  assert.equal(result.error, undefined);
  assert.deepEqual(result.effects, ["fetch", "persist", "fetch"]);
  assert.equal(result.puts.length, 1);
  const { expectedVersion, asHub, fields } = result.puts[0];
  assert.deepEqual({ expectedVersion, asHub, token: fields.oauthToken, refresh: fields.oauthRefreshToken },
    { expectedVersion: 4, asHub: true, token, refresh });
}
