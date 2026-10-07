import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { githubConnectionInstallationIds, githubUserCanAccessInstallation, listGitHubUserInstallations } from "../src/app-connectors.ts";

const load = await compileCommonJsSourceModule(new URL("../src/index-routes-auth-space-management.ts", import.meta.url));
const env = { GITHUB_APP_CLIENT_SECRET: "app-secret" };

const account = (installationId, login, type = "Organization") => ({ installationId, login, type });

function fixture({ linkedToken = "user-token", reachable = ["111"], stored = ["111"], listed = [],
  status = "configured" } = {}) {
  const upserts = [];
  const reachability = [];
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
      listGitHubUserInstallations: async () => reachable.map((id) => account(id, `acct-${id}`, "User")),
      githubUserCanAccessInstallation: async (_env, token, id) => { reachability.push([token, id]); return reachable.includes(id); },
    },
    "./better-auth": { linkedGitHubAccessToken: async () => linkedToken },
    "./deployment-origins": { appOrigin: () => "https://xmatrix.test" },
    "./index-shared": {
      verifyGitHubAppState: async (state) => state === "signed" ? { spaceId: "space-1", userId: "admin" } : null,
      requireAuth: async () => ({ id: "admin" }), requireHumanAuth: (user) => user,
      productCommandId: () => "command",
      jsonErrors: async (context, run) => { try { return await run(); } catch (error) { return context.json({ error: error.message }, 500); } },
    },
  };
  const app = new Hono();
  load((name) => imports[name] ?? {}).registerIndexRoutesAuthSpaceManagement(app);
  const setup = (installationId) => app.request(
    `/api/apps/github/setup?state=signed&installation_id=${installationId}&setup_action=install`, {}, env);
  const patch = (metadata) => app.request("/api/spaces/space-1/app-connections/github", { method: "PATCH",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "github", metadata }) }, env);
  return { app, setup, patch, upserts, reachability };
}

const outcome = (response) => new URL(response.headers.get("location")).searchParams.get("github");

test("an installation the admin's GitHub account cannot reach is never linked", async () => {
  const f = fixture({ reachable: ["111"] });
  const response = await f.setup("999");
  assert.equal(outcome(response), "failed");
  assert.deepEqual(f.reachability, [["user-token", "999"]]);
  assert.deepEqual(f.upserts, []);
});

test("without a linked GitHub account nothing is linked and the admin is asked to link one", async () => {
  const f = fixture({ linkedToken: null });
  assert.equal(outcome(await f.setup("111")), "account_required");
  assert.deepEqual(f.upserts, []);
});

test("an installation the admin can reach is linked", async () => {
  const f = fixture({ reachable: ["111"] });
  assert.equal(outcome(await f.setup("111")), "connected");
  assert.equal(f.upserts.length, 1);
  assert.deepEqual(f.upserts[0].body.metadataAppend, { installationIds: "111" });
});

test("setup appends its installation and never replaces the stored metadata", async () => {
  const f = fixture({ reachable: ["111", "222"] });
  assert.equal(outcome(await f.setup("222")), "connected");
  assert.equal(outcome(await f.setup("222")), "connected");
  assert.equal(outcome(await f.setup("111")), "connected");
  assert.equal(f.upserts.length, 3);
  for (const upsert of f.upserts) {
    // No `metadata` key: the db keeps every stored field and only appends to installationIds.
    assert.equal("metadata" in upsert.body, false);
  }
  assert.deepEqual(f.upserts.map((upsert) => upsert.body.metadataAppend.installationIds), ["222", "222", "111"]);
  // A repeated setup is its own command, so its differing body cannot hit a replay mismatch.
  assert.equal(new Set(f.upserts.map((upsert) => upsert.commandId)).size, 3);
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

test("Connect after Disconnect replaces the installations it left behind and keeps the scopes", async () => {
  const f = fixture({ reachable: ["222"], listed: [{ providerId: "github", status: "disconnected",
    scopes: ["metadata:read", "contents:write"], metadata: { installationIds: ["111"], repository: "org/repo" } }] });
  assert.equal(outcome(await f.setup("222")), "connected");
  assert.equal(f.upserts.length, 1);
  assert.deepEqual(f.upserts[0].body.metadata, { repository: "org/repo" });
  assert.deepEqual(f.upserts[0].body.metadataAppend, { installationIds: "222" });
  assert.equal("scopes" in f.upserts[0].body, false);
});

test("Configure lists the linked accounts and the reachable ones not linked yet", async () => {
  const f = fixture({ stored: ["111", "404"], reachable: ["111", "222"] });
  const response = await f.app.request("/api/spaces/space-1/app-connections/github/installations", {}, env);
  const body = await response.json();
  assert.deepEqual(body.linked.map((item) => [item.installationId, item.login]),
    [["111", "org-111"], ["404", "Installation 404"]]);
  assert.deepEqual(body.available.map((item) => item.installationId), ["222"]);
  assert.equal(body.accountRequired, false);
});

test("a disconnected connection lists nothing as linked", async () => {
  const f = fixture({ stored: ["111"], reachable: ["111"], status: "disconnected" });
  const body = await (await f.app.request("/api/spaces/space-1/app-connections/github/installations", {}, env)).json();
  assert.deepEqual(body.linked, []);
  assert.deepEqual(body.available.map((item) => item.installationId), ["111"]);
});

test("Link asks for the same proof as the install callback", async () => {
  const f = fixture({ reachable: ["222"] });
  const link = (installationId) => f.app.request("/api/spaces/space-1/app-connections/github/installations", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installationId }) }, env);
  assert.equal((await link("999")).status, 403);
  assert.equal((await link("../1")).status, 400);
  assert.deepEqual(f.upserts, []);
  assert.equal((await link("222")).status, 200);
  assert.deepEqual(f.upserts.map((upsert) => upsert.body.metadataAppend), [{ installationIds: "222" }]);
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

test("installation reachability pages GitHub's list of the user's installations", async () => {
  const original = globalThis.fetch;
  const pages = [Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })), [{ id: 4242 }]];
  const requested = [];
  globalThis.fetch = async (url, init) => {
    requested.push([String(url), init.headers.get("authorization")]);
    const page = Number(new URL(String(url)).searchParams.get("page"));
    return Response.json({ installations: pages[page - 1] ?? [] });
  };
  try {
    assert.equal(await githubUserCanAccessInstallation({}, "user-token", "4242"), true);
    assert.equal(requested.length, 2);
    assert.match(requested[0][0], /\/user\/installations\?per_page=100&page=1$/u);
    assert.equal(requested[0][1], "Bearer user-token");
    assert.equal(await githubUserCanAccessInstallation({}, "user-token", "5000"), false);
    assert.equal(await githubUserCanAccessInstallation({}, "user-token", "../1"), false);
  } finally { globalThis.fetch = original; }
});

test("the user's installations are read as accounts and malformed ones are dropped", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ installations: [
    { id: 7, repository_selection: "all",
      account: { login: "yiming", type: "User", avatar_url: "https://avatars.githubusercontent.com/u/1" } },
    { id: 8, account: { login: "LambdaLabsHQ", type: "Organization", avatar_url: "javascript:alert(1)" } },
    { id: "x", account: { login: "broken" } },
  ] });
  try {
    assert.deepEqual(await listGitHubUserInstallations({}, "user-token"), [
      { installationId: "7", login: "yiming", type: "User",
        avatarUrl: "https://avatars.githubusercontent.com/u/1", repositorySelection: "all" },
      { installationId: "8", login: "LambdaLabsHQ", type: "Organization" },
    ]);
  } finally { globalThis.fetch = original; }
});
