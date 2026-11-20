import assert from "node:assert/strict";
import test from "node:test";

import {
  countNeedsYou,
  listSpaces,
  listChannels,
  pollDeviceSignIn,
  sendMessage,
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
  const { calls, deps } = fakeHub({ "POST /api/channels/c1/messages": () => ({ json: { message: { messageId: "m1" } } }) });
  await sendMessage(deps, "t", { channelId: "c1", body: "hi", clientMessageId: "m1" });
  assert.equal(calls[0].headers["x-xmatrix-client-component"], "app");
  assert.equal(calls[0].headers["x-xmatrix-client-protocol"], "2");
  assert.equal(calls[0].headers["x-xmatrix-client-version"], "4.7.3");
  assert.equal(calls[0].headers.authorization, "Bearer t");
  // A bare @Agent mention is refused unless the send asks to launch it.
  assert.deepEqual(calls[0].body, { body: "hi", clientMessageId: "m1", launch: true });
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
  assert.deepEqual(approved.session, {
    token: "t", refreshToken: "r", user: { id: "u1", name: "d@example.test" }, hubUrl: "https://hub.test",
  });
  await assert.rejects(pollDeviceSignIn(deps, "dc"), /Declined in the browser/u);
});

test("conversations waiting on the person come first, then the most recent", async () => {
  const { deps } = fakeHub({
    "GET /api/channels": () => ({
      json: {
        channels: [
          { id: "old", spaceId: "s1", name: "Old", lastMessage: { sentAt: "2026-11-01T00:00:00Z" } },
          { id: "new", spaceId: "s1", topic: "New topic", lastMessage: { sentAt: "2026-11-20T00:00:00Z" } },
          { id: "wait", spaceId: "s1", name: "Waiting", attention: { unreadAttentionCount: 2 } },
          { id: "other", spaceId: "s2", name: "Other Space" },
        ],
      },
    }),
  });
  const channels = await listChannels(deps, "t", "s1");
  assert.deepEqual(channels.map((channel) => [channel.id, channel.name, channel.needsYou]), [
    ["wait", "Waiting", true],
    ["new", "New topic", false],
    ["old", "Old", false],
  ]);
});

test("the badge counts each waiting conversation once across the snapshot and the list", async () => {
  const { deps } = fakeHub({
    "GET /api/channels": () => ({
      json: {
        channels: [{ id: "a", attention: { unreadAttentionCount: 1 } }, { id: "b", attention: { unreadAttentionCount: 0 } }],
        attentionSnapshot: { spaces: [{ summaries: [{ channelId: "a", unreadAttentionCount: 3 }, { channelId: "c", unreadAttentionCount: 1 }] }] },
      },
    }),
  });
  assert.equal(await countNeedsYou(deps, "t"), 2);
});
