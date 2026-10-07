import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { githubConnectionInstallationIds, listGitHubUserInstallations } from "../src/app-connectors.ts";

const load = await compileCommonJsSourceModule(new URL("../src/index-routes-auth-space-management.ts", import.meta.url));
const env = { GITHUB_APP_CLIENT_SECRET: "app-secret" };

const account = (installationId, login, type = "Organization") => ({ installationId, login, type });

function fixture({ granted = ["111"], stored = ["111"], listed = [], status = "configured",
  statePayload = { spaceId: "space-1", userId: "admin" } } = {}) {
  const upserts = [];
  const authorizations = [];
  const imports = {
    hono: { Hono },
    "./apps": {
      upsertAppConnection: async (_env, input) => { upserts.push(input); return { connection: {} }; },
      listAppConnections: async () => listed,
      findAppConnection: async () => ({ providerId: "github", status,
        metadata: { installationIds: stored, repository: "org/repo" } }),
    },
    "./app-connectors": {
      githubConnectionInstallationIds,
      describeGitHubInstallation: async (_env, id) => id === "404" ? undefined : account(id, `org-${id}`),
    },
    "./github-connect-authorization": {
      githubConnectAuthorizeUrl: async (_env, input) => {
        authorizations.push(input);
        return `https://github.test/authorize?installation=${input.installation?.id ?? ""}`;
      },
      githubConnectReturnUrl: (_env, outcome, target = {}) =>
        `https://xmatrix.test/connect/github?github=${outcome}${target.spaceId ? `&space=${target.spaceId}` : ""}`,
      // The grant "grant" is this admin's own authorization for space-1.
      githubGrantInstallationIds: async (_env, grant, input) =>
        grant === "grant" && input.spaceId === "space-1" && input.userId === "admin" ? granted : undefined,
    },
    "./deployment-origins": { appOrigin: () => "https://xmatrix.test" },
    "./index-shared": {
      verifyGitHubAppState: async (state) => state === "signed" ? statePayload : null,
      requireAuth: async () => ({ id: "admin" }), requireHumanAuth: (user) => user,
      productCommandId: () => "command",
      jsonErrors: async (context, run) => { try { return await run(); } catch (error) { return context.json({ error: error.message }, 500); } },
    },
  };
  const app = new Hono();
  load((name) => imports[name] ?? {}).registerIndexRoutesAuthSpaceManagement(app);
  const setup = (installationId, action = "install") => app.request(
    `/api/apps/github/setup?state=signed&installation_id=${installationId}&setup_action=${action}`, {}, env);
  const patch = (metadata) => app.request("/api/spaces/space-1/app-connections/github", { method: "PATCH",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "github", metadata }) }, env);
  const link = (installationId, grant = "grant") => app.request("/api/spaces/space-1/app-connections/github/installations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installationId, grant }) }, env);
  const list = (grant) => app.request(`/api/spaces/space-1/app-connections/github/installations${grant ? `?grant=${grant}` : ""}`, {}, env);
  return { app, setup, patch, link, list, upserts, authorizations };
}

const outcome = (response) => new URL(response.headers.get("location")).searchParams.get("github");

test("setup never links an installation itself; the installer proves on GitHub that they reach it", async () => {
  const f = fixture();
  const response = await f.setup("999", "update");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://github.test/authorize?installation=999");
  assert.deepEqual(f.authorizations, [{ spaceId: "space-1", userId: "admin",
    installation: { id: "999", setupAction: "update" } }]);
  assert.deepEqual(f.upserts, []);
});

test("setup refuses a connect state or grant used as an install state", async () => {
  const f = fixture({ statePayload: { purpose: "github-grant", spaceId: "space-1", userId: "admin" } });
  assert.equal(outcome(await f.setup("111")), "failed");
  assert.deepEqual(f.authorizations, []);
});

test("setup reports a pending approval and a cancelled install without authorizing", async () => {
  const f = fixture();
  const pending = await f.setup("111", "request");
  assert.equal(pending.headers.get("location"), "https://xmatrix.test/connect/github?github=pending&space=space-1");
  assert.equal(outcome(pending), "pending");
  assert.equal(outcome(await f.setup("111", "other")), "cancelled");
  assert.deepEqual(f.authorizations, []);
});

test("Link links only an installation the admin's own grant for this Space names", async () => {
  const f = fixture({ granted: ["222"] });
  assert.equal((await f.link("222", null)).status, 409);
  assert.equal((await f.link("222", "someone-elses-grant")).status, 409);
  assert.equal((await f.link("999")).status, 403);
  assert.equal((await f.link("../1")).status, 400);
  assert.deepEqual(f.upserts, []);
  assert.equal((await f.link("222")).status, 200);
  assert.deepEqual(f.upserts.map((upsert) => upsert.body.metadataAppend), [{ installationIds: "222" }]);
});

test("Link appends and never replaces the stored metadata of a connected Space", async () => {
  const f = fixture({ granted: ["111", "222"], listed: [{ providerId: "github", status: "configured",
    scopes: ["metadata:read"], metadata: { installationIds: ["111"], repository: "org/repo" } }] });
  assert.equal((await f.link("222")).status, 200);
  assert.equal((await f.link("222")).status, 200);
  for (const upsert of f.upserts) {
    // No `metadata` key: the db keeps every stored field and only appends to installationIds.
    assert.equal("metadata" in upsert.body, false);
    assert.equal("scopes" in upsert.body, false);
  }
  // A repeated link is its own command, so its differing body cannot hit a replay mismatch.
  assert.equal(new Set(f.upserts.map((upsert) => upsert.commandId)).size, 2);
});

test("the first link sets the baseline scopes", async () => {
  const f = fixture({ granted: ["111"] });
  assert.equal((await f.link("111")).status, 200);
  assert.deepEqual(f.upserts[0].body.scopes, ["metadata:read", "issues:read"]);
});

test("Link after Disconnect replaces the installations it left behind and keeps the scopes", async () => {
  const f = fixture({ granted: ["222"], listed: [{ providerId: "github", status: "disconnected",
    scopes: ["metadata:read", "contents:write"], metadata: { installationIds: ["111"], repository: "org/repo" } }] });
  assert.equal((await f.link("222")).status, 200);
  assert.deepEqual(f.upserts[0].body.metadata, { repository: "org/repo" });
  assert.deepEqual(f.upserts[0].body.metadataAppend, { installationIds: "222" });
  assert.equal("scopes" in f.upserts[0].body, false);
});

test("Configure cannot append an installation", async () => {
  const f = fixture({ stored: ["111"] });
  const response = await f.app.request("/api/spaces/space-1/app-connections/github", { method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "github", metadataAppend: { installationIds: "999" } }) }, env);
  assert.equal(response.status, 400);
  assert.deepEqual(f.upserts, []);
});

test("Configure may send the stored installations back but never different ones", async () => {
  const f = fixture({ stored: ["111"] });
  assert.equal((await f.patch({ installationIds: ["111", "999"], repository: "org/repo" })).status, 400);
  assert.equal((await f.patch({ installationId: "999" })).status, 400);
  assert.deepEqual(f.upserts, []);
  assert.notEqual((await f.patch({ installationIds: ["111"], repository: "org/repo" })).status, 400);
  assert.equal(f.upserts.length, 1);
});

test("Disconnect forgets the linked installations and keeps the rest of the configuration", async () => {
  const f = fixture({ stored: ["111", "222"] });
  const response = await f.app.request("/api/spaces/space-1/app-connections/github", { method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerId: "github", status: "disconnected" }) }, env);
  assert.notEqual(response.status, 400);
  assert.equal(f.upserts.length, 1);
  assert.equal(f.upserts[0].body.status, "disconnected");
  assert.deepEqual(f.upserts[0].body.metadata, { repository: "org/repo" });
});

test("the accounts list shows linked accounts, and after authorizing the granted ones not linked yet", async () => {
  const f = fixture({ stored: ["111", "404"], granted: ["111", "222"] });
  const without = await (await f.list()).json();
  assert.deepEqual(without.linked.map((item) => [item.installationId, item.login]),
    [["111", "org-111"], ["404", "Installation 404"]]);
  assert.deepEqual(without.available, []);
  assert.equal(without.authorized, false);
  const authorized = await (await f.list("grant")).json();
  assert.deepEqual(authorized.available.map((item) => item.installationId), ["222"]);
  assert.equal(authorized.authorized, true);
});

test("a disconnected connection lists nothing as linked", async () => {
  const f = fixture({ stored: ["111"], granted: ["111"], status: "disconnected" });
  const body = await (await f.list("grant")).json();
  assert.deepEqual(body.linked, []);
  assert.deepEqual(body.available.map((item) => item.installationId), ["111"]);
});

test("Unlink forgets one installation and disconnects only when none is left", async () => {
  const unlink = (f, id) => f.app.request(`/api/spaces/space-1/app-connections/github/installations/${id}`,
    { method: "DELETE" }, env);
  const two = fixture({ stored: ["111", "222"] });
  assert.equal((await unlink(two, "999")).status, 404);
  assert.equal((await unlink(two, "111")).status, 200);
  assert.deepEqual(two.upserts[0].body.metadata, { repository: "org/repo", installationIds: ["222"] });
  assert.equal("status" in two.upserts[0].body, false);
  const one = fixture({ stored: ["111"] });
  assert.equal((await unlink(one, "111")).status, 200);
  assert.deepEqual(one.upserts[0].body.metadata, { repository: "org/repo" });
  assert.equal(one.upserts[0].body.status, "disconnected");
});

test("the user's installations are paged and read as accounts, dropping malformed ones", async () => {
  const original = globalThis.fetch;
  const requested = [];
  const first = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, account: { login: `a${index}` } }));
  const second = [
    { id: 7000, repository_selection: "all",
      account: { login: "yiming", type: "User", avatar_url: "https://avatars.githubusercontent.com/u/1" } },
    { id: 8000, account: { login: "LambdaLabsHQ", type: "Organization", avatar_url: "javascript:alert(1)" } },
    { id: "x", account: { login: "broken" } },
  ];
  globalThis.fetch = async (url, init) => {
    requested.push([String(url), init.headers.get("authorization")]);
    const page = Number(new URL(String(url)).searchParams.get("page"));
    return Response.json({ installations: page === 1 ? first : second });
  };
  try {
    const accounts = await listGitHubUserInstallations({}, "user-token");
    assert.equal(requested.length, 2);
    assert.match(requested[0][0], /\/user\/installations\?per_page=100&page=1$/u);
    assert.equal(requested[0][1], "Bearer user-token");
    assert.equal(accounts.length, 102);
    assert.deepEqual(accounts.slice(100), [
      { installationId: "7000", login: "yiming", type: "User",
        avatarUrl: "https://avatars.githubusercontent.com/u/1", repositorySelection: "all" },
      { installationId: "8000", login: "LambdaLabsHQ", type: "Organization" },
    ]);
  } finally { globalThis.fetch = original; }
});

test("Connect names every GitHub App setting a deployment left unset", async () => {
  const f = fixture();
  const response = await f.app.request("/api/apps/github/install?spaceId=space-1&mode=add", {},
    { GITHUB_APP_ID: "42", GITHUB_APP_CLIENT_SECRET: "secret", GITHUB_APP_PRIVATE_KEY: "key", GITHUB_APP_SLUG: " " });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(),
    { error: "GitHub App is not configured: GITHUB_APP_CLIENT_ID, GITHUB_APP_SLUG unset" });
  assert.deepEqual(f.authorizations, []);
});
