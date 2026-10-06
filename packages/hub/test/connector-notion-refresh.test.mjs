import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTION_ACTIONS } from "../src/connectors/actions/notion.ts";
import { credentialExecutor } from "./support/connection-credentials-fixture.mjs";

const env = { CONNECTOR_NOTION_CLIENT_ID: "fixture-client", CONNECTOR_NOTION_CLIENT_SECRET: "fixture-secret" };
const pair = { integrationToken: "fixture-access", oauthRefreshToken: "fixture-refresh" };
const rotated = { access_token: "fixture-new-access", refresh_token: "fixture-new-refresh" };

async function scenario(responses, { credentials = pair, rejectWrite = false, writeAction = false } = {}) {
  const original = globalThis.fetch;
  const effects = [];
  const puts = [];
  const repository = {
    resolve: async () => ({ values: credentials, version: 7 }),
    put: async input => {
      effects.push("persist"); puts.push(input);
      if (rejectWrite) throw new Error("Connector credentials changed during refresh");
    },
  };
  const connectionCredentials = credentialExecutor(repository);
  globalThis.fetch = async (url, init = {}) => {
    const response = responses.shift();
    assert.ok(response, `unexpected call: ${url}`);
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    effects.push({ path, method, authorization: new Headers(init.headers).get("authorization"), body: init.body });
    if (response.error) throw response.error;
    return new Response(JSON.stringify(response.body ?? { object: "user", id: "fixture-bot" }), { status: response.status ?? 200 });
  };
  let result, error;
  try {
    result = await connectionCredentials(env, "space-notion", "notion");
    if (writeAction) await NOTION_ACTIONS.append.execute({ credentials: result }, { page: "fixture-page", text: "test" });
  } catch (failure) { error = failure; }
  finally { globalThis.fetch = original; }
  return { result, error, effects, puts };
}

test("Notion without expiry rotates once after read-only 401 and persists before verification and one write", async () => {
  const run = await scenario([{ status: 401 }, { body: rotated }, {}, {}], { writeAction: true });
  assert.equal(run.error, undefined);
  assert.deepEqual(run.effects.map(effect => typeof effect === "string" ? effect : `${effect.method} ${effect.path}`),
    ["GET /v1/users/me", "POST /v1/oauth/token", "persist", "GET /v1/users/me", "PATCH /v1/blocks/fixture-page/children"]);
  assert.deepEqual(JSON.parse(run.effects[1].body), { grant_type: "refresh_token", refresh_token: pair.oauthRefreshToken });
  assert.equal(run.effects[1].authorization, `Basic ${btoa("fixture-client:fixture-secret")}`);
  assert.equal(run.effects[3].authorization, "Bearer fixture-new-access");
  assert.equal(run.effects[4].authorization, "Bearer fixture-new-access");
  assert.equal(run.puts[0].expectedVersion, 7);
  assert.equal(run.puts[0].asHub, true);
  assert.equal(run.puts[0].fields.integrationToken, rotated.access_token);
  assert.equal(run.puts[0].fields.oauthRefreshToken, rotated.refresh_token);
});

test("healthy OAuth does not rotate and manual integrations retain their request path", async () => {
  const healthy = await scenario([{}]);
  assert.equal(healthy.error, undefined);
  assert.equal(healthy.puts.length, 0);
  assert.equal(healthy.effects.length, 1);
  const manual = await scenario([{}], { credentials: { integrationToken: "manual-fixture" }, writeAction: true });
  assert.equal(manual.error, undefined);
  assert.deepEqual(manual.effects.map(effect => effect.method), ["PATCH"]);
});

test("permission failures, rate limits and timeouts neither rotate nor execute writes", async () => {
  for (const response of [{ status: 403 }, { status: 429 }, { error: new DOMException("Timed out", "TimeoutError") }]) {
    const run = await scenario([response], { writeAction: true });
    assert.ok(run.error);
    assert.equal(run.effects.length, 1);
    assert.equal(run.puts.length, 0);
  }
});

test("failed or incomplete token rotation leaves the stored pair untouched and prevents writes", async () => {
  for (const response of [{ status: 401 }, { body: { access_token: "new-without-refresh" } },
    { body: { refresh_token: "new-without-access" } }]) {
    const run = await scenario([{ status: 401 }, response], { writeAction: true });
    assert.ok(run.error);
    assert.equal(run.puts.length, 0);
    assert.equal(run.effects.length, 2);
  }
});

test("a verification failure after rotation keeps the new pair and never rotates or writes again", async () => {
  for (const response of [{ status: 401 }, { error: new DOMException("Timed out", "TimeoutError") }]) {
    const run = await scenario([{ status: 401 }, { body: rotated }, response], { writeAction: true });
    assert.ok(run.error);
    assert.equal(run.puts.length, 1);
    assert.equal(run.puts[0].fields.oauthRefreshToken, rotated.refresh_token);
    assert.equal(run.effects.filter(effect => effect?.path === "/v1/oauth/token").length, 1);
    assert.equal(run.effects.filter(effect => effect?.method === "PATCH").length, 0);
  }
});

test("a provider-supplied expired token rotates before its verification read", async () => {
  const run = await scenario([{ body: rotated }, {}], { credentials: { ...pair, oauthExpiresAt: "1" } });
  assert.equal(run.error, undefined);
  assert.deepEqual(run.effects.map(effect => typeof effect === "string" ? effect : effect.path),
    ["/v1/oauth/token", "persist", "/v1/users/me"]);
});
