import assert from "node:assert/strict";
import test from "node:test";

import {
  freshAccessToken,
  hubUrl,
  listSpaces,
  pollDeviceSignIn,
  withSession,
} from "../src/hub-client.js";

/** A Hub that answers each path from `routes` and records what it was sent. */
function fakeHub(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const { pathname, search } = new URL(url);
    calls.push({ path: pathname + search, method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const answer = await routes[`${init.method} ${pathname}`]?.(calls.at(-1));
    if (!answer) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200 });
  };
  return { calls, deps: { fetch, hubUrl: "https://hub.test", version: "4.7.3" } };
}

function memoryStore(session) {
  let value = session;
  return { get: async () => value, set: async (next) => { value = next; }, peek: () => value };
}

const session = { token: "old", refreshToken: "refresh-1", user: null, hubUrl: "https://hub.test" };

// The Hub refuses bearer requests whose client identity is missing or unknown
// once legacy admission is off (client-compatibility-gate.ts); the extension
// must declare itself as an app on every call.
test("every call declares an app client identity the Hub's compatibility gate admits", async () => {
  const { calls, deps } = fakeHub({ "GET /api/spaces": () => ({ json: { spaces: [] } }) });
  await listSpaces(deps, "t");
  assert.equal(calls[0].headers["x-xmatrix-client-component"], "app");
  assert.equal(calls[0].headers["x-xmatrix-client-protocol"], "2");
  assert.equal(calls[0].headers["x-xmatrix-client-version"], "4.7.3");
  assert.equal(calls[0].headers.authorization, "Bearer t");
});

test("an expired access token is renewed once and the call retried with the new one", async () => {
  const { calls, deps } = fakeHub({
    "GET /api/spaces": ({ headers }) => (headers.authorization === "Bearer new"
      ? { json: { spaces: [] } } : { status: 401, json: { error: "expired" } }),
    "POST /api/auth/refresh": () => ({ json: { token: "new", refreshToken: "refresh-2", user: { id: "u1", name: "Dana" } } }),
  });
  const store = memoryStore(session);
  await withSession(deps, store, listSpaces);
  assert.deepEqual(calls.map((call) => call.path), ["/api/spaces", "/api/auth/refresh", "/api/spaces"]);
  assert.equal(store.peek().refreshToken, "refresh-2");
});

test("a refused renewal forgets the session so the popup asks to sign in again", async () => {
  const { deps } = fakeHub({
    "GET /api/spaces": () => ({ status: 401, json: { error: "expired" } }),
    "POST /api/auth/refresh": () => ({ status: 401, json: { error: "revoked" } }),
  });
  const store = memoryStore(session);
  await assert.rejects(withSession(deps, store, listSpaces), (error) => error.code === "signed_out");
  assert.equal(store.peek(), null);
});

test("a renewal that fails for another reason keeps the session", async () => {
  const { deps } = fakeHub({
    "GET /api/spaces": () => ({ status: 401, json: { error: "expired" } }),
    "POST /api/auth/refresh": () => ({ status: 503, json: { error: "unavailable" } }),
  });
  const store = memoryStore(session);
  await assert.rejects(withSession(deps, store, listSpaces), (error) => error.status === 503);
  assert.equal(store.peek(), session);
});

test("device sign-in reports waiting, then the session, and ends on a declined request", async () => {
  const answers = [
    { status: "pending", interval: 7 },
    { status: "approved", token: "t", refreshToken: "r", user: { id: "u1", email: "d@example.test" } },
    { status: "expired", error: "Declined in the browser." },
  ];
  const { deps } = fakeHub({ "POST /api/auth/cli/device/token": () => ({ json: answers.shift() }) });
  assert.deepEqual(await pollDeviceSignIn(deps, "dc"), { pending: true, intervalMs: 7000 });
  const approved = await pollDeviceSignIn(deps, "dc");
  // The account is kept as the Hub names it: the panel's app opens with it.
  assert.deepEqual(approved.session, {
    token: "t", refreshToken: "r", hubUrl: "https://hub.test",
    user: { id: "u1", name: "d@example.test", email: "d@example.test", avatarUrl: undefined },
  });
  await assert.rejects(pollDeviceSignIn(deps, "dc"), /Declined in the browser/u);
});

function jwt(expSeconds) {
  return `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
}

test("the side panel gets the current token while it has life left, and a renewed one near its end", async () => {
  const now = Math.floor(Date.now() / 1000);
  const renewed = jwt(now + 3600);
  const { calls, deps } = fakeHub({ "POST /api/auth/refresh": () => ({ json: { token: renewed, refreshToken: "refresh-2" } }) });
  const store = memoryStore({ ...session, token: jwt(now + 1800) });
  assert.equal(await freshAccessToken(deps, store), store.peek().token);
  assert.equal(calls.length, 0);
  await store.set({ ...session, token: jwt(now + 60) });
  assert.equal(await freshAccessToken(deps, store), renewed);
  assert.equal(store.peek().refreshToken, "refresh-2");
});

test("a renewal keeps the account it was signed in as, and takes the Hub's when it names one", async () => {
  const account = { id: "u1", name: "Dana", email: "d@example.test", avatarUrl: undefined };
  const answers = [{ token: jwt(1), refreshToken: "refresh-2" },
    { token: jwt(2), refreshToken: "refresh-3", user: { id: "u1", name: "Dana Scully", email: "d@example.test" } }];
  const { deps } = fakeHub({ "POST /api/auth/refresh": () => ({ json: answers.shift() }) });
  const store = memoryStore({ ...session, token: jwt(0), user: account });
  await freshAccessToken(deps, store);
  assert.deepEqual(store.peek().user, account);
  // Asked for outright (the account was renamed under the token), whatever life the token has left.
  await store.set({ ...store.peek(), token: jwt(Math.floor(Date.now() / 1000) + 3600) });
  await freshAccessToken(deps, store, Infinity);
  assert.equal(store.peek().user.name, "Dana Scully");
  assert.equal(store.peek().refreshToken, "refresh-3");
});

test("the Hub a build talks to is the one host its manifest may reach", () => {
  assert.equal(hubUrl({ host_permissions: ["https://xmatrix-hub.xmatrix.sh/*"] }), "https://xmatrix-hub.xmatrix.sh");
  assert.equal(hubUrl({ host_permissions: ["http://localhost:8787/*"] }), "http://localhost:8787");
});

test("a refused renewal for the side panel signs it out", async () => {
  const { deps } = fakeHub({ "POST /api/auth/refresh": () => ({ status: 401, json: { error: "revoked" } }) });
  const store = memoryStore({ ...session, token: jwt(0) });
  assert.equal(await freshAccessToken(deps, store), null);
  assert.equal(store.peek(), null);
});
