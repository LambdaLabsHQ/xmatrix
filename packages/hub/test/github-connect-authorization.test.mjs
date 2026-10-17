import assert from "node:assert/strict";
import test from "node:test";

import * as authorization from "../src/github-connect-authorization.ts";
import { signGitHubAppState } from "../src/index-shared.ts";
import { githubAppEnv } from "./support/github-app.mjs";
const {
  completeGitHubConnectAuthorization,
  githubConnectAuthorizeUrl,
  githubGrantInstallationIds,
  isGitHubConnectState,
  handoffGitHubConnectAuthorization,
} = authorization;

const env = {
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  HUB_URL: "https://hub.test",
  APP_URL: "https://app.test",
  ...await githubAppEnv(),
};

const API = "https://api.github.com";

/**
 * GitHub for the person connecting (`viewer`): the code exchange, the
 * installations they reach, and, for an organization's, each repository it
 * covers with whether they administer it or see it at all. A bare id is an
 * installation on the viewer's own account.
 */
async function withGitHub(reachable, run, viewer = "the-admin") {
  const installations = reachable.map((entry) => typeof entry === "string"
    ? { id: entry, type: "User", login: viewer, repositories: [] } : entry);
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    requests.push({ url: target, body: init.body ? JSON.parse(init.body) : undefined });
    if (target === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "user-token" });
    if (target === `${API}/user`) return Response.json({ login: viewer });
    if (target.startsWith(`${API}/user/installations?`)) {
      return Response.json({ installations: installations.map(({ id, type, login }) => ({ id: Number(id), account: { login, type } })) });
    }
    const minted = target.match(/\/app\/installations\/(\d+)\/access_tokens$/u);
    if (minted) return Response.json({ token: `installation-${minted[1]}` });
    const covering = installations.find(({ id }) => new Headers(init.headers).get("authorization") === `Bearer installation-${id}`);
    if (target.startsWith(`${API}/installation/repositories?`) && covering) {
      return Response.json({ total_count: covering.repositories.length, repositories: [] });
    }
    const listed = installations.find(({ id }) => target.startsWith(`${API}/user/installations/${id}/repositories?`));
    if (listed) {
      const seen = listed.repositories.map((repository, index) => ({ ...repository, id: index + 1 }))
        .filter((repository) => repository.visible !== false);
      return Response.json({ total_count: seen.length, repositories: seen.map(({ id, admin }) => ({ id, permissions: { admin } })) });
    }
    return new Response("not found", { status: 404 });
  };
  try { return await run(requests); } finally { globalThis.fetch = original; }
}

async function callback(state, query = "code=the-code", userId = "admin") {
  const links = [];
  const response = await completeGitHubConnectAuthorization(env,
    new Request(`https://hub.test/api/auth/callback/github?${query}&state=${encodeURIComponent(state)}`),
    async (...args) => { links.push(args); return true; }, { userId, authorizeSpace: async () => {} });
  return { response, links, location: new URL(response.headers.get("location")) };
}

const stateOf = (url) => new URL(url).searchParams.get("state");

test("Connect authorizes with the App's own client on its registered callback", async () => {
  const url = new URL(await githubConnectAuthorizeUrl(env, { spaceId: "space-1", userId: "admin" }));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("redirect_uri"), "https://hub.test/api/auth/callback/github");
  assert.equal(isGitHubConnectState(url.searchParams.get("state")), true);
  assert.equal(isGitHubConnectState("better-auth-random-state"), false);
});

test("authorizing returns a grant of exactly the installations this person administers, for this Space", async () => {
  const state = stateOf(await githubConnectAuthorizeUrl(env, { spaceId: "space-1", userId: "admin" }));
  await withGitHub(["111", "222"], async (requests) => {
    const { location, links } = await callback(state);
    assert.equal(location.origin + location.pathname, "https://app.test/connect/github");
    assert.equal(location.searchParams.get("space"), "space-1");
    assert.equal(location.searchParams.get("github"), "authorized");
    assert.deepEqual(links, []);
    const grant = location.searchParams.get("grant");
    assert.deepEqual(await githubGrantInstallationIds(env, grant, { spaceId: "space-1", userId: "admin" }), ["111", "222"]);
    assert.equal(await githubGrantInstallationIds(env, grant, { spaceId: "space-2", userId: "admin" }), undefined);
    assert.equal(await githubGrantInstallationIds(env, grant, { spaceId: "space-1", userId: "other" }), undefined);
    assert.deepEqual(requests[0].body, { client_id: "client-id", client_secret: "client-secret", code: "the-code",
      redirect_uri: "https://hub.test/api/auth/callback/github" });
  });
});

test("a fresh installation is linked only when the installer administers it", async () => {
  const fresh = (setupAction) => githubConnectAuthorizeUrl(env, { spaceId: "space-1", userId: "admin",
    installation: { id: "222", setupAction } });
  await withGitHub(["111", "222"], async () => {
    const installed = await callback(stateOf(await fresh("install")));
    assert.equal(installed.location.searchParams.get("github"), "connected");
    assert.deepEqual(installed.links, [["space-1", "admin", "222"]]);
    const updated = await callback(stateOf(await fresh("update")));
    assert.equal(updated.location.searchParams.get("github"), "updated");
  });
  await withGitHub(["111"], async () => {
    const unreachable = await callback(stateOf(await fresh("install")));
    assert.equal(unreachable.location.searchParams.get("github"), "failed");
    assert.deepEqual(unreachable.links, []);
  });
});

test("reaching an installation through some of its repositories does not hand it to a Space", async () => {
  const acme = (repositories) => ({ type: "Organization", login: "acme", repositories });
  const reachable = [
    { id: "333", ...acme([{ admin: true }, { admin: false }]) },
    { id: "444", ...acme([{ admin: true }, { admin: true }]) },
    { id: "555", ...acme([{ admin: true }, { admin: true, visible: false }]) },
    { id: "666", type: "User", login: "someone-else", repositories: [] },
  ];
  const state = stateOf(await githubConnectAuthorizeUrl(env, { spaceId: "space-1", userId: "admin" }));
  await withGitHub(reachable, async () => {
    const grant = (await callback(state)).location.searchParams.get("grant");
    assert.deepEqual(await githubGrantInstallationIds(env, grant, { spaceId: "space-1", userId: "admin" }), ["444"],
      "only an organization whose every covered repository they administer, never a collaborator's reach");
    for (const id of ["333", "555", "666"]) {
      const fresh = await callback(stateOf(await githubConnectAuthorizeUrl(env, { spaceId: "space-1", userId: "admin",
        installation: { id, setupAction: "update" } })));
      assert.equal(fresh.location.searchParams.get("github"), "failed");
      assert.deepEqual(fresh.links, []);
    }
  });
});

test("a declined authorization, a forged state, or a grant as a state links nothing", async () => {
  const state = stateOf(await githubConnectAuthorizeUrl(env, { spaceId: "space-1", userId: "admin" }));
  await withGitHub(["111"], async () => {
    const declined = await callback(state, "error=access_denied");
    assert.equal(declined.location.searchParams.get("github"), "cancelled");
    const forged = await callback(`${state.slice(0, -2)}xx`);
    assert.equal(forged.location.toString(), "https://app.test/connect/github?github=failed");
    const granted = (await callback(state)).location.searchParams.get("grant");
    const asState = await callback(`xmgh.${granted}`);
    assert.equal(asState.location.toString(), "https://app.test/connect/github?github=failed");
    assert.deepEqual([...declined.links, ...forged.links, ...asState.links], []);
  });
});

test("a different signed-in person cannot give the initiator's Space their GitHub installations", async () => {
  for (const installation of [{ id: "222", setupAction: "install" }, undefined]) {
    const state = stateOf(await githubConnectAuthorizeUrl(env, { spaceId: "space-1", userId: "admin", installation }));
    await withGitHub(["111", "222"], async requests => {
      const result = await callback(state, "code=other-persons-code", "other-person");
      assert.equal(result.location.searchParams.get("github"), "failed");
      assert.deepEqual(result.links, []);
      assert.equal(result.location.searchParams.has("grant"), false);
      assert.deepEqual(requests, [], "identity is checked before code exchange or installation discovery");
    });
  }
});

test("a grant issued before installation authority was checked must be authorized again", async () => {
  for (const purpose of ["github-grant", "github-grant:v2"]) {
    const legacy = await signGitHubAppState({ purpose, spaceId: "space-1", userId: "admin",
      installationIds: ["111"], expiresAt: Date.now() + 60_000 }, env.GITHUB_APP_CLIENT_SECRET);
    assert.equal(await githubGrantInstallationIds(env, legacy, { spaceId: "space-1", userId: "admin" }), undefined);
  }
});

test("the anonymous GitHub callback only hands state and code to authenticated completion", async () => {
  const state = stateOf(await githubConnectAuthorizeUrl(env, { spaceId: "space-1", userId: "admin" }));
  await withGitHub(["111"], async requests => {
    const request = new Request(`https://hub.test/api/auth/callback/github?code=private-code&state=${encodeURIComponent(state)}&installation_id=999`);
    const response = await handoffGitHubConnectAuthorization(env, request);
    const target = new URL(response.headers.get("location"));
    assert.equal(target.origin + target.pathname, "https://app.test/connect/oauth");
    assert.deepEqual(Object.fromEntries(target.searchParams), { state, code: "private-code" });
    assert.deepEqual(requests, [], "anonymous callbacks exchange no code and discover no installations");
  });
});
