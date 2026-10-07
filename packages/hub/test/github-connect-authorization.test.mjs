import assert from "node:assert/strict";
import test from "node:test";

import {
  completeGitHubConnectAuthorization,
  githubConnectAuthorizeUrl,
  githubGrantInstallationIds,
  isGitHubConnectState,
} from "../src/github-connect-authorization.ts";

const env = {
  GITHUB_APP_CLIENT_ID: "client-id",
  GITHUB_APP_CLIENT_SECRET: "client-secret",
  HUB_URL: "https://hub.test",
  APP_URL: "https://app.test",
};

/** GitHub answering the code exchange and the user's installation list. */
async function withGitHub(reachable, run) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    requests.push({ url: target, body: init.body ? JSON.parse(init.body) : undefined });
    if (target === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "user-token" });
    if (target.includes("/user/installations")) {
      return Response.json({ installations: reachable.map((id) => ({ id: Number(id), account: { login: `a${id}` } })) });
    }
    return new Response("not found", { status: 404 });
  };
  try { return await run(requests); } finally { globalThis.fetch = original; }
}

async function callback(state, query = "code=the-code") {
  const links = [];
  const response = await completeGitHubConnectAuthorization(env,
    new Request(`https://hub.test/api/auth/callback/github?${query}&state=${encodeURIComponent(state)}`),
    async (...args) => { links.push(args); return true; });
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

test("authorizing returns a grant of exactly the installations this person reaches, for this Space", async () => {
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

test("a fresh installation is linked only when the installer reaches it", async () => {
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
