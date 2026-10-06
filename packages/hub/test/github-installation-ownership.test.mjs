import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { githubConnectionInstallationIds, githubUserCanAccessInstallation } from "../src/app-connectors.ts";

const load = await compileCommonJsSourceModule(new URL("../src/index-routes-auth-space-management.ts", import.meta.url));
const env = { GITHUB_APP_CLIENT_SECRET: "app-secret" };

function fixture({ linkedToken = "user-token", reachable = ["111"], stored = ["111"] } = {}) {
  const upserts = [];
  const reachability = [];
  const imports = {
    hono: { Hono },
    "./apps": {
      upsertAppConnection: async (_env, input) => { upserts.push(input); return { connection: {} }; },
      listAppConnections: async () => [],
      findAppConnection: async () => ({ providerId: "github", metadata: { installationIds: stored } }),
    },
    "./app-connectors": {
      githubConnectionInstallationIds,
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
  return { setup, patch, upserts, reachability };
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
  assert.equal(f.upserts[0].body.metadata.installationId, "111");
});

test("Configure may send the stored installations back but never different ones", async () => {
  const f = fixture({ stored: ["111"] });
  assert.equal((await f.patch({ installationIds: ["111", "999"], repository: "org/repo" })).status, 400);
  assert.equal((await f.patch({ installationId: "999" })).status, 400);
  assert.deepEqual(f.upserts, []);
  assert.notEqual((await f.patch({ installationIds: ["111"], repository: "org/repo" })).status, 400);
  assert.equal(f.upserts.length, 1);
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
