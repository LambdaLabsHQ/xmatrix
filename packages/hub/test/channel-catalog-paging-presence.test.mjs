import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import * as boundary from "./support/channel-catalog-paging-dependencies.mjs";
import { state } from "./support/channel-catalog-paging-dependencies.mjs";

// Keep the real route handlers and the real Runtime presence overlay. Only the
// authentication, Authority transport and RelayRuntime bindings are injected.
import { registerChannelCatalogPagingRoutes } from "../src/channel-catalog-paging-routes.ts";
import { createChannelCatalogReader } from "../src/channel-catalog-read.ts";

const app = new Hono();
registerChannelCatalogPagingRoutes(app, boundary);
const { readChannelForPrincipal } = createChannelCatalogReader(boundary);

const OPEN_CHANNEL = {
  id: "channel-1", spaceId: "space-1", name: "General", mode: "open", version: 1,
  // Catalog authority only knows durable Agent presence; the live Human half of
  // this projection exists solely as a RelayRuntime session.
  memberPresence: { "agent:writer": { kind: "agent", label: "writer", instances: [] } },
  createdBy: "owner", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};
const LIVE_SESSION = {
  userId: "online", name: "Online Person", email: "online@example.com",
  lastSeenAt: "2026-09-17T00:00:00.000Z", focusedChannelId: "channel-1",
};

function reset(payload) {
  state.requests.length = 0;
  state.runtimeSessions = [LIVE_SESSION];
  state.payload = payload;
  state.runtimeFetch = null;
  state.authorityResult = null;
}

test("a catalog page completes Agent-only presence with live Humans", async () => {
  reset({
    protocolVersion: 1, catalogRevision: 9, nextCursor: null, counts: null,
    openChannelHumanMemberIdsBySpace: { "space-1": ["user:online", "user:offline"] },
    rows: [{ channel: OPEN_CHANNEL, ownActivityAt: "2026-09-01T00:01:00.000Z",
      hasChildren: false, subtreeActivityAt: "2026-09-01T00:01:00.000Z" }],
  });

  const response = await app.request(
    "https://hub.test/api/channels/page?spaceId=space-1&view=flat&filter=all", {}, {},
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  const presence = payload.rows[0].channel.memberPresence;
  assert.equal(presence["user:online"].status, "online");
  assert.equal(presence["user:online"].focused, true);
  // Durable Agent presence survives the overlay, and an offline member stays
  // directory membership rather than becoming a presence row.
  assert.equal(presence["agent:writer"].kind, "agent");
  assert.equal(presence["user:offline"], undefined);
  // The read hint is an internal Hub input, not part of the client contract.
  assert.equal(payload.openChannelHumanMemberIdsBySpace, undefined);
  assert.equal(payload.rows[0].ownActivityAt, "2026-09-01T00:01:00.000Z");
});

test("a counts-only page never reads Runtime presence", async () => {
  reset({
    protocolVersion: 1, catalogRevision: 9, nextCursor: null, rows: [],
    counts: { active: 1, archive: 0, direct: 0, unread: 0, mentions: 0 },
  });

  const response = await app.request(
    "https://hub.test/api/channels/page?spaceId=space-1&view=flat&filter=all&countsOnly=true",
    {}, {},
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).counts,
    { active: 1, archive: 0, direct: 0, unread: 0, mentions: 0 });
  assert.equal(state.requests.some((request) => request.kind === "runtime"), false);
});

/** Resolve channel-1 of space-1 through the Hub route. */
async function resolveChannelOne() {
  const response = await app.request("https://hub.test/api/channels/resolve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId: "space-1", channelIds: ["channel-1"] }),
  }, {});
  assert.equal(response.status, 200);
  return response.json();
}

test("a resolved Channel carries live Human presence", async () => {
  resetOpenChannelResolve();

  const payload = await assertResolvedOnlineHuman();
  assert.deepEqual(payload.pathsByChannelId, { "channel-1": ["channel-1"] });
  assert.equal(payload.openChannelHumanMemberIdsBySpace, undefined);
});

test("a closed Channel reports presence from its own visible membership", async () => {
  reset({
    protocolVersion: 1,
    channels: [{ ...OPEN_CHANNEL, mode: "closed", visibleHumanMemberIds: ["user:online"] }],
    pathsByChannelId: { "channel-1": ["channel-1"] },
  });

  await assertResolvedOnlineHuman();
});

test("an unavailable Runtime leaves the catalog answer intact", async () => {
  resetOpenChannelResolve();
  state.runtimeSessions = [];

  const payload = await resolveChannelOne();
  assert.equal(payload.channels[0].memberPresence["user:online"], undefined);
  assert.equal(payload.channels[0].memberPresence["agent:writer"].kind, "agent");
});

test("metadata-only resolve preserves omitted participant fields and skips Runtime", async () => {
  const { memberPresence: _memberPresence, ...metadata } = OPEN_CHANNEL;
  reset({ protocolVersion: 1, channels: [metadata],
    pathsByChannelId: { "channel-1": ["channel-1"] } });
  const response = await app.request("https://hub.test/api/channels/resolve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId: "space-1", channelIds: ["channel-1"],
      includeAncestors: true, includeParticipants: false }),
  }, {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.channels, [metadata]);
  assert.equal(state.requests.some(request => request.kind === "runtime"), false);
  assert.equal(state.requests.some(request => request.input?.includeParticipants === false), true);
});

test("an invalid catalog cursor starts neither Runtime nor Authority work", async () => {
  reset({});
  const response = await app.request("https://hub.test/api/channels/page?spaceId=space-1&cursor=invalid!");
  assert.equal(response.status, 400);
  assert.deepEqual(state.requests, []);
});

for (const failure of ["timeout", "error", "invalid-body", "body-timeout", "fetch-rejection", "body-rejection", "invalid-json"]) {
  test(`catalog ${failure} omits unknown presence without dropping authorized rows`, async () => {
    reset({ protocolVersion: 1, rows: [{ channel: OPEN_CHANNEL, hasChildren: false }], nextCursor: null });
    let signal;
    let bodyCancelled = false;
    state.runtimeFetch = (request) => {
      signal = request.signal;
      signal.addEventListener("abort", () => {}, { once: true });
      if (failure === "error") return new Response(null, { status: 503 });
      if (failure === "invalid-body") return Response.json({ broken: true });
      if (failure === "fetch-rejection") throw new Error("Runtime unavailable");
      if (failure === "body-rejection") return new Response(new ReadableStream({
        start(controller) { controller.error(new Error("Body interrupted")); },
      }));
      if (failure === "invalid-json") return new Response("{truncated");
      if (failure === "body-timeout") return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }));
      return new Promise(() => {});
    };
    const response = await app.request("https://hub.test/api/channels/page?spaceId=space-1");
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.rows[0].channel.id, OPEN_CHANNEL.id);
    assert.equal(Object.hasOwn(payload.rows[0].channel, "memberPresence"), false);
    if (failure.includes("timeout")) assert.equal(signal.aborted, true);
    if (failure === "body-timeout") assert.equal(bodyCancelled, true);
  });
}

test("optional presence timeout never changes a denied catalog into a successful page", async () => {
  reset({});
  state.runtimeFetch = () => new Promise(() => {});
  state.authorityResult = { ok: false, response: new Response("Forbidden", { status: 403 }) };
  const response = await app.request("https://hub.test/api/channels/page?spaceId=private");
  assert.equal(response.status, 403);
});

test("a successful empty snapshot is distinct from unavailable presence", async () => {
  reset({ protocolVersion: 1, rows: [{ channel: OPEN_CHANNEL, hasChildren: false }], nextCursor: null });
  state.runtimeSessions = [];
  const response = await app.request("https://hub.test/api/channels/page?spaceId=space-1");
  const payload = await response.json();
  assert.equal(payload.rows[0].channel.memberPresence["agent:writer"].kind, "agent");
  assert.equal(payload.rows[0].channel.memberPresence["user:online"], undefined);
});

test("a late Runtime response is discarded and its body cancelled", async () => {
  reset({ protocolVersion: 1, rows: [{ channel: OPEN_CHANNEL, hasChildren: false }], nextCursor: null });
  let finish;
  let cancelled = false;
  state.runtimeFetch = () => new Promise(resolve => { finish = resolve; });
  const response = await app.request("https://hub.test/api/channels/page?spaceId=space-1");
  const payload = await response.json();
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(Object.hasOwn(payload.rows[0].channel, "memberPresence"), false);
});

const FAMILY = [
  { ...OPEN_CHANNEL, id: "root" },
  { ...OPEN_CHANNEL, id: "thread", parentChannelId: "root",
    metadata: { kind: "thread", threadRootChannelId: "root", threadRootMessageId: "m1" } },
];

test("a Channel family read routes by the Channel for a user and asks only for its family", async () => {
  reset({ channels: FAMILY });
  const read = await readChannelForPrincipal({}, { kind: "user", id: "viewer" }, "root");
  assert.equal(read.ok, true);
  assert.deepEqual(read.channels.map((channel) => channel.id), ["root", "thread"]);
  // A partial read never claims catalog-level completeness.
  assert.equal(read.attentionSnapshot, undefined);
  assert.equal(read.projectionCacheManifest, undefined);
  assert.equal(read.catalogSync, undefined);
  const listed = state.requests.find((request) => request.kind === "list-channels");
  assert.equal(listed.input.familyOfChannelId, "root");
  assert.equal(listed.input.spaceId, undefined);
  // No Space directory fan-out for a single-Channel read.
  assert.equal(state.requests.some((request) => request.kind === "list-spaces"), false);
});

test("an Agent-run family read stays in the token Space and fails closed without one", async () => {
  reset({ channels: FAMILY });
  const agent = { kind: "agent", id: "agent-1", spaceId: "space-1" };
  const read = await readChannelForPrincipal({}, agent, "root");
  assert.equal(read.ok, true);
  const listed = state.requests.find((request) => request.kind === "list-channels");
  assert.deepEqual(listed.input, {
    spaceId: "space-1", principal: { kind: "agent", id: "agent-1" }, familyOfChannelId: "root", limit: 200,
  });
  reset({ channels: FAMILY });
  const spaceless = await readChannelForPrincipal({}, { kind: "agent", id: "agent-1" }, "root");
  assert.equal(spaceless.ok, false);
  assert.equal(spaceless.response.status, 403);
  assert.deepEqual(state.requests, []);
});

test("a family whose Channel the principal cannot read is not found, never its children", async () => {
  reset({ channels: [FAMILY[1]] });
  const read = await readChannelForPrincipal({}, { kind: "user", id: "viewer" }, "root");
  assert.equal(read.ok, false);
  assert.equal(read.response.status, 404);
  reset({});
  state.authorityResult = { ok: false, response: new Response("Forbidden", { status: 403 }) };
  const denied = await readChannelForPrincipal({}, { kind: "user", id: "viewer" }, "root");
  assert.equal(denied.response.status, 403);
});

function resetOpenChannelResolve() {
  reset({ protocolVersion: 1, channels: [OPEN_CHANNEL], openChannelHumanMemberIdsBySpace: { "space-1": ["user:online"] },
    pathsByChannelId: { "channel-1": ["channel-1"] } });
}

async function assertResolvedOnlineHuman() {
  const payload = await resolveChannelOne();
  assert.equal(payload.channels[0].memberPresence["user:online"].status, "online");
  return payload;
}
