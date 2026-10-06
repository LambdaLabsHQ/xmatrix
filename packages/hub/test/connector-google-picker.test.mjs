import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { Hono } from "hono";
import { HUB_ROUTES } from "@xmatrix/protocol";
import { providerJson, ProviderRequestError } from "../src/connectors/http.ts";
import { oauthClient } from "../src/connectors/oauth.ts";

const env = { CONNECTOR_GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com", CONNECTOR_GOOGLE_CLIENT_SECRET: "private-client-secret",
  CONNECTOR_GOOGLE_PICKER_API_KEY: "fixture_public_picker_key_123456", CONNECTOR_GOOGLE_PICKER_APP_ID: "218762573462" };
const id = "fixture_document_123456";
const ts = createRequire(import.meta.url)("typescript");
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function setup({ admin = true, status = "configured", versionAfter = 7, roleAfter = true, refreshChanged = false } = {}) {
  let reads = 0;
  const authorized = [];
  const repository = {
    readGenerated: async input => {
      authorized.push(input);
      if (!admin || (reads >= 2 && !roleAfter)) throw Object.assign(new Error("Space not found"), { status: 404 });
      assert.deepEqual(Array.from(input.generated), []);
      return {};
    },
    resolve: async () => ({ version: ++reads >= 3 ? versionAfter : 7, status,
      values: { oauthToken: "private-space-token", oauthRefreshToken: "private-refresh" } }),
  };
  const dependencies = {
    "./credentials": { connectorCredentialRepository: () => repository },
    "./connection-credentials": { connectionCredentials: async () => ({ oauthToken: refreshChanged ? "other-token" : "private-space-token" }) },
    "./http": { providerJson, ProviderRequestError }, "./oauth": { oauthClient },
  };
  const exports = {};
  runInNewContext(compile("../src/connectors/google-picker.ts"), { exports, require: name => dependencies[name], crypto, URL });
  return { functions: exports, authorized };
}

test("Picker configuration exposes only public parameters after the current admin and connection check", async () => {
  const { functions, authorized } = setup();
  const result = await functions.configuredGooglePicker(env, "space-a", "admin-a");
  assert.deepEqual(Object.keys(result).sort(), ["apiKey", "appId", "clientId"]);
  assert.equal(authorized[0].actorUserId, "admin-a");
  assert.equal(authorized[0].spaceId, "space-a");
  assert.doesNotMatch(JSON.stringify(result), /private-client-secret|private-space-token|private-refresh/);
  for (const options of [{ admin: false }, { status: "disconnected" }, { status: "error" }]) {
    await assert.rejects(setup(options).functions.configuredGooglePicker(env, "space-a", "member"));
  }
  await assert.rejects(functions.configuredGooglePicker({ ...env, CONNECTOR_GOOGLE_PICKER_APP_ID: "invalid" }, "space-a", "admin-a"), /not configured/);
});

async function withFile(options, response, operation) {
  const { functions, authorized } = setup(options);
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return new Response(JSON.stringify(response.body ?? {}), { status: response.status ?? 200 });
  };
  try { return await operation(functions, calls, authorized); }
  finally { globalThis.fetch = original; }
}
const file = { id, name: "Requirements", mimeType: "application/vnd.google-apps.document", isAppAuthorized: true, trashed: false };

test("selected files are confirmed using only this Space's server grant; provider links and browser tokens are not trusted", async () => {
  await withFile({}, { body: { ...file, webViewLink: "https://evil.test/redirect" } }, async (functions, calls, authorized) => {
    const result = await functions.confirmGooglePickerFile(env, "space-a", "admin-a", id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.get("authorization"), "Bearer private-space-token");
    assert.equal(new URL(calls[0].url).origin, "https://www.googleapis.com");
    assert.equal(new URL(calls[0].url).searchParams.get("fields"), "id,name,mimeType,trashed,isAppAuthorized");
    assert.equal(authorized.length, 3);
    assert.equal(result.file.url, `https://docs.google.com/document/d/${id}/edit`);
    assert.doesNotMatch(JSON.stringify(result), /private-|evil/);
  });
});

test("spreadsheet selection confirms the same Space grant and returns only a canonical Sheets link and kind", async () => {
  await withFile({}, { body: { ...file, mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://evil.test" } }, async (functions, calls) => {
    const result = await functions.confirmGooglePickerFile(env, "space-a", "admin-a", id);
    assert.equal(result.file.kind, "sheet");
    assert.equal(result.file.url, `https://docs.google.com/spreadsheets/d/${id}/edit`);
    assert.equal(calls[0].headers.get("authorization"), "Bearer private-space-token");
    assert.doesNotMatch(JSON.stringify(result), /private-|evil/u);
  });
});

test("wrong-account, denied, trashed, mismatched and unsupported file selections fail closed", async () => {
  for (const response of [{ status: 403 }, { status: 404 }, { body: { ...file, isAppAuthorized: false } },
    { body: { ...file, trashed: true } }, { body: { ...file, id: "different_doc_1234" } },
    { body: { ...file, mimeType: "application/pdf" } }, { body: {} }]) {
    await withFile({}, response, functions => assert.rejects(functions.confirmGooglePickerFile(env, "space-a", "admin-a", id)));
  }
});

test("revoked role, changed grant and disconnected connections do not return stale confirmations", async () => {
  for (const options of [{ versionAfter: 8 }, { roleAfter: false }, { status: "disconnected" }, { refreshChanged: true }]) {
    await withFile(options, { body: file }, functions => assert.rejects(functions.confirmGooglePickerFile(env, "space-a", "admin-a", id)));
  }
  await withFile({}, { body: file }, async (functions, calls) => {
    await assert.rejects(functions.confirmGooglePickerFile(env, "space-a", "admin-a", "../other?fields=all"), /Invalid/);
    assert.equal(calls.length, 0);
  });
});

test("the Picker route refuses Agent auth, bounded malformed bodies, and private error payloads", async () => {
  const exports = {};
  let agent = false;
  let confirmationError = false;
  let calls = 0;
  const dependencies = {
    "@xmatrix/protocol": { HUB_ROUTES },
    "./connectors/google-picker": { configuredGooglePicker: async () => ({ clientId: "public" }),
      confirmGooglePickerFile: async (_, spaceId, userId, fileId) => {
        calls++; assert.equal(spaceId, "space-a"); assert.equal(userId, "admin-a"); assert.equal(fileId, id);
        if (confirmationError) throw new ProviderRequestError(403, "private-provider-payload");
        return { file: { id } };
      } },
    "./connectors/http": { ProviderRequestError },
    "./index-shared": { requireAuth: async () => ({ agentRun: agent }), requireHumanAuth: () => ({ id: "admin-a" }),
      requestErrorStatus: error => error.status ?? 500, readBoundedRequestBody: async (request, max) => {
        const bytes = new Uint8Array(await request.arrayBuffer()); return bytes.length <= max ? bytes : undefined;
      } },
  };
  runInNewContext(compile("../src/index-routes-google-picker.ts"), { exports, require: name => dependencies[name], JSON, TextDecoder });
  const app = new Hono(); exports.registerGooglePickerRoutes(app);
  const url = HUB_ROUTES.space_app_connection_google_picker("space-a");
  agent = true;
  assert.equal((await app.request(url, {}, env)).status, 403);
  assert.equal(calls, 0);
  agent = false;
  const configured = await app.request(url, {}, env);
  assert.equal(configured.headers.get("cache-control"), "private, no-store");
  for (const [body, expected] of [["bad-json", 400], [JSON.stringify({ accessToken: "browser-private" }), 400], ["x".repeat(2048), 413]]) {
    assert.equal((await app.request(url, { method: "POST", body }, env)).status, expected);
  }
  confirmationError = true;
  const result = await app.request(url, { method: "POST", body: JSON.stringify({ fileId: id, accessToken: "browser-private" }) }, env);
  assert.equal(result.status, 403);
  assert.doesNotMatch(await result.text(), /private-/);
});
