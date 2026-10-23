const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const paging = fs.readFileSync(path.join(__dirname, "use-channel-catalog-paging.ts"), "utf8").replace(/\r\n/g, "\n");

const refresh = fs.readFileSync(path.join(__dirname, "channel-catalog-refresh.ts"), "utf8");

async function openCatalogRefresh() {
  const { QueryClient } = require("@tanstack/react-query");
  const { refreshSpaceCatalogForEvent } = require("./channel-catalog-refresh.ts");
  return {
    refreshSpaceCatalogForEvent,
    client: new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } }),
    prefix: ["xmatrix", "hub", "user", "channels", "space"],
  };
}

test("message activity refreshes unloaded flat rows and inactive filtered lists within its Space", async () => {
  const { refreshSpaceCatalogForEvent, client, prefix } = await openCatalogRefresh();
  const fetched = [];
  const resolved = [];
  const keys = [
    [...prefix, "catalog", "flat", "all", null, ""],
    [...prefix, "catalog", "flat", "unread", null, ""],
    [...prefix, "catalog", "tree", "all", "unrelated-parent", ""],
    ["xmatrix", "hub", "other-user", "channels", "space", "catalog", "flat", "all", null, ""],
  ];
  try {
    for (const [index, queryKey] of keys.entries()) {
      await client.fetchQuery({ queryKey, queryFn: async () => {
        fetched.push(index);
        return { pages: [{ rows: [] }], pageParams: [null] };
      } });
    }
    fetched.length = 0;
    refreshSpaceCatalogForEvent({ client, spaceId: "space", prefix,
      countsKey: [...prefix, "catalog-counts"], detail: { kind: "message", channelId: "unloaded" },
      hasChannel: () => false, resolveChannel: (...args) => resolved.push(args) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(fetched.sort(), [0, 1]);
    assert.deepEqual(resolved, [["space", "unloaded"]]);
  } finally { client.clear(); }
});

test("message activity promotes a loaded flat row and refetches only the lists that lack it", async () => {
  const { refreshSpaceCatalogForEvent, client, prefix } = await openCatalogRefresh();
  const loadedKey = [...prefix, "catalog", "flat", "all", null, ""];
  const unreadKey = [...prefix, "catalog", "flat", "unread", null, ""];
  const countsKey = [...prefix, "catalog-counts"];
  const fetched = [];
  const row = (id, at) => ({ channel: { id }, ownActivityAt: at });
  try {
    client.setQueryData(loadedKey, {
      pages: [{
        rows: [row("other", "2026-10-06T00:00:00.000Z"), row("known", "2026-10-05T00:00:00.000Z")],
        protocolVersion: 1, catalogRevision: 1, nextCursor: null, counts: null,
      }],
      pageParams: [null],
    });
    await client.fetchQuery({ queryKey: unreadKey, queryFn: async () => {
      fetched.push("unread");
      return { pages: [{ rows: [], protocolVersion: 1, catalogRevision: 1, nextCursor: null, counts: null }], pageParams: [null] };
    } });
    await client.fetchQuery({ queryKey: countsKey, queryFn: async () => {
      fetched.push("counts");
      return { active: 2 };
    } });
    fetched.length = 0;
    const resolved = [];
    refreshSpaceCatalogForEvent({
      client, spaceId: "space", prefix, countsKey,
      detail: { kind: "message", channelId: "known", at: "2026-10-06T01:00:00.000Z" },
      hasChannel: () => true, resolveChannel: (...args) => resolved.push(args),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fetched, ["unread"]);
    assert.equal(client.getQueryState(countsKey).isInvalidated, true);
    assert.deepEqual(resolved, []);
    const rows = client.getQueryData(loadedKey).pages[0].rows;
    assert.deepEqual(rows.map((item) => item.channel.id), ["known", "other"]);
    assert.equal(rows[0].ownActivityAt, "2026-10-06T01:00:00.000Z");
  } finally { client.clear(); }
});

async function openMessageRefresh() {
  const { QueryClient } = require("@tanstack/react-query");
  const { refreshSpaceCatalogForMessages } = require("./channel-catalog-refresh.ts");
  const prefix = ["xmatrix", "hub", "user", "channels", "space"];
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const fetched = [];
  const page = (rows, nextCursor = null) => ({ rows, protocolVersion: 1, catalogRevision: 4, nextCursor, counts: null });
  const hold = async (key, pages) => client.fetchQuery({ queryKey: key, queryFn: async () => {
    fetched.push(key[6] + ":" + key[7]);
    return { pages, pageParams: pages.map((_, index) => index ? `cursor-${index}` : null) };
  } });
  const countsKey = [...prefix, "catalog-counts"];
  /** A window's messages against the Channels the entity table holds; gives back what was sent to resolve. */
  const arrive = (entities, details) => {
    const resolved = [];
    refreshSpaceCatalogForMessages({
      client, spaceId: "space", prefix, countsKey, viewerId: "user", details,
      hasChannel: (id) => entities.has(id), channel: (id) => entities.get(id),
      resolveChannel: (...args) => resolved.push(args),
    });
    return resolved;
  };
  return { refreshSpaceCatalogForMessages, client, prefix, fetched, page, hold, arrive, countsKey,
    conversations: [...prefix, "catalog", "flat", "all", null, ""],
    unread: [...prefix, "catalog", "flat", "unread", null, ""] };
}

const catalogRow = (id, at) => ({ channel: { id, spaceId: "space" }, ownActivityAt: at });

test("a window's messages bring known conversations into the list without reading it again", async () => {
  const t = await openMessageRefresh();
  try {
    await t.hold(t.conversations, [
      t.page([catalogRow("first", "2026-10-06T00:00:00.000Z")], "cursor-1"),
      t.page([catalogRow("paged", "2026-10-01T00:00:00.000Z")]),
    ]);
    await t.hold(t.unread, [t.page([])]);
    t.fetched.length = 0;
    const entities = new Map([
      ["quiet", { id: "quiet", spaceId: "space", updatedAt: "2026-10-02T00:00:00.000Z" }],
      ["paged", { id: "paged", spaceId: "space" }],
    ]);
    const resolved = t.arrive(entities, [
      { kind: "message", channelId: "quiet", at: "2026-10-06T02:00:00.000Z" },
      { kind: "message", channelId: "paged", at: "2026-10-06T03:00:00.000Z" },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    const data = t.client.getQueryData(t.conversations);
    // Newest first, each Channel once, and every page keeps its own cursor.
    assert.deepEqual(data.pages.map((item) => item.rows.map((row) => row.channel.id)), [["paged", "quiet", "first"], []]);
    assert.deepEqual(data.pages.map((item) => item.nextCursor), ["cursor-1", null]);
    assert.equal(data.pages[0].rows[1].channel, entities.get("quiet"));
    assert.equal(data.pages[0].rows[1].ownActivityAt, "2026-10-06T02:00:00.000Z");
    // The list a filter chose its rows for cannot be told who belongs: it is
    // read again, once for the window rather than once per message.
    assert.deepEqual(t.fetched, ["flat:unread"]);
    assert.deepEqual(resolved, []);
  } finally { t.client.clear(); }
});

test("a conversation the reader's list cannot hold is not put into it", async () => {
  const t = await openMessageRefresh();
  try {
    await t.hold(t.conversations, [t.page([catalogRow("first", "2026-10-06T00:00:00.000Z")])]);
    t.fetched.length = 0;
    const entities = new Map([
      ["theirs", { id: "theirs", spaceId: "space", metadata: { intakeOf: "someone-else" } }],
      ["mine", { id: "mine", spaceId: "space", metadata: { intakeOf: "user" } }],
      ["elsewhere", { id: "elsewhere", spaceId: "other-space" }],
    ]);
    const resolved = t.arrive(entities,
      ["theirs", "mine", "elsewhere", "unknown"].map((channelId) => ({ kind: "message", channelId })));
    // Only the reader's own intake is theirs to list. What the list lacks is
    // answered by the Hub: one read for the three it could not place.
    assert.deepEqual(t.client.getQueryData(t.conversations).pages[0].rows.map((row) => row.channel.id), ["mine", "first"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(t.fetched, ["flat:all"]);
    // A Channel nobody here knows is the Hub's to show this reader, or not.
    assert.deepEqual(resolved, [["space", "unknown"]]);
  } finally { t.client.clear(); }
});

test("Channels nobody here knows wait for the Hub's one answer instead of a read of the whole list", async () => {
  const t = await openMessageRefresh();
  try {
    await t.hold(t.conversations, [t.page([catalogRow("first", "2026-10-06T00:00:00.000Z")])]);
    await t.hold(t.unread, [t.page([])]);
    t.fetched.length = 0;
    const entities = new Map();
    const asked = [];
    const window = ["far", "farther", "hidden"].map((channelId, index) => (
      { kind: "message", channelId, at: `2026-10-06T0${index + 1}:00:00.000Z` }));
    const lists = { client: t.client, spaceId: "space", prefix: t.prefix, countsKey: t.countsKey, viewerId: "user",
      resolveChannel: () => assert.fail("a window's unknown Channels are one read") };
    t.refreshSpaceCatalogForMessages({ ...lists, details: window, hasChannel: (id) => entities.has(id),
      channel: (id) => entities.get(id), resolveMessageChannels: (...args) => asked.push(args) });
    await new Promise((resolve) => setImmediate(resolve));
    // One question for the window; the conversation list is not read again for it.
    assert.deepEqual(asked, [["space", window]]);
    assert.deepEqual(t.fetched, ["flat:unread"]);
    assert.deepEqual(t.client.getQueryData(t.conversations).pages[0].rows.map((row) => row.channel.id), ["first"]);

    // The Hub shows this reader two of the three: those join the list, newest first.
    entities.set("far", { id: "far", spaceId: "space" }).set("farther", { id: "farther", spaceId: "space" });
    t.fetched.length = 0;
    t.refreshSpaceCatalogForMessages({ ...lists, details: window.filter((detail) => entities.has(detail.channelId)),
      hasChannel: () => true, channel: (id) => entities.get(id) });
    await new Promise((resolve) => setImmediate(resolve));
    const rows = t.client.getQueryData(t.conversations).pages[0].rows;
    assert.deepEqual(rows.map((row) => row.channel.id), ["farther", "far", "first"]);
    assert.equal(rows[0].ownActivityAt, "2026-10-06T02:00:00.000Z");
    assert.deepEqual(t.fetched, ["flat:unread"]);

    // Without the answer (the read failed) the list itself is read again.
    t.fetched.length = 0;
    t.refreshSpaceCatalogForMessages({ ...lists, details: [window[2]], hasChannel: () => true, channel: () => undefined });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(t.fetched.sort(), ["flat:all", "flat:unread"]);
  } finally { t.client.clear(); }
});

test("a row that moves in the list stays the row it was, and a read that repeats the list changes nothing", async () => {
  const { QueryClient } = require("@tanstack/react-query");
  const { refreshSpaceCatalogForMessages, shareCatalogRows } = require("./channel-catalog-refresh.ts");
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const prefix = ["xmatrix", "hub", "user", "channels", "space"];
  const queryKey = [...prefix, "catalog", "flat", "all", null, ""];
  const read = (id, at, presence) => ({ channel: { id, spaceId: "space", metadata: { tags: [id] },
    memberPresence: { agent: { status: presence } } }, ownActivityAt: at });
  let answer = ["first", "second", "third"].map((id, index) => read(id, `2026-10-0${6 - index}T00:00:00.000Z`, "busy"));
  const options = { queryKey, structuralSharing: shareCatalogRows, queryFn: async () => (
    { pages: [{ rows: answer, protocolVersion: 1, catalogRevision: 4, nextCursor: null, counts: null }], pageParams: [null] }) };
  try {
    await client.fetchQuery(options);
    const held = client.getQueryData(queryKey);
    const [first, second, third] = held.pages[0].rows;

    // A message moves the last row to the top: every row is the object it was,
    // the one that moved apart from when it was last active.
    refreshSpaceCatalogForMessages({ client, spaceId: "space", prefix, countsKey: [...prefix, "catalog-counts"],
      details: [{ kind: "message", channelId: "third", at: "2026-10-07T00:00:00.000Z" }],
      hasChannel: () => true, resolveChannel: () => undefined });
    const moved = client.getQueryData(queryKey).pages[0].rows;
    assert.deepEqual(moved.map((row) => row.channel.id), ["third", "first", "second"]);
    assert.equal(moved[1], first);
    assert.equal(moved[2], second);
    assert.equal(moved[0].channel, third.channel);

    // The Hub answers the same list again, in its own order: nothing is new.
    answer = [moved[0], first, second].map((row) => JSON.parse(JSON.stringify(row)));
    const before = client.getQueryData(queryKey);
    await client.fetchQuery({ ...options, staleTime: 0 });
    assert.equal(client.getQueryData(queryKey), before);

    // One Channel changed: its row is the new read, the others stay.
    answer = [moved[0], read("first", first.ownActivityAt, "offline"), second].map((row) => JSON.parse(JSON.stringify(row)));
    await client.fetchQuery({ ...options, staleTime: 0 });
    const after = client.getQueryData(queryKey).pages[0].rows;
    assert.equal(after[0], moved[0]);
    assert.equal(after[2], second);
    assert.notEqual(after[1], first);
    assert.equal(after[1].channel.memberPresence.agent.status, "offline");
  } finally { client.clear(); }
});

test("a read asked under an authorization that ended stays ended when the same values come back", async () => {
  const { NO_CATALOG_LEASES, nextCatalogLeases } = require("./channel-catalog-refresh.ts");
  const session = "xmatrix\u0000hub\u0000user";
  const signedIn = nextCatalogLeases(NO_CATALOG_LEASES, session, ["space", "other"]);
  const asked = signedIn.bySpace.get("space");
  assert.ok(asked);
  // A token renewed without a gap changes nothing the reads stand on.
  assert.equal(nextCatalogLeases(signedIn, session, ["space", "other"]), signedIn);
  // One Space is left and joined again: its reads ended, the other Space's did not.
  const left = nextCatalogLeases(signedIn, session, ["other"]);
  const back = nextCatalogLeases(left, session, ["space", "other"]);
  assert.equal(left.bySpace.get("space"), undefined);
  assert.notEqual(back.bySpace.get("space"), asked);
  assert.equal(back.bySpace.get("other"), signedIn.bySpace.get("other"));
  // The sign-in is lost and returns with the same account, Hub and Space.
  const out = nextCatalogLeases(signedIn, session, []);
  const again = nextCatalogLeases(out, session, ["space", "other"]);
  assert.equal(out.bySpace.size, 0);
  assert.notEqual(again.bySpace.get("space"), asked);
  assert.notEqual(again.bySpace.get("other"), signedIn.bySpace.get("other"));
  // Another account on the same Space never inherits a lease.
  const theirs = nextCatalogLeases(signedIn, "xmatrix\u0000hub\u0000someone-else", ["space"]);
  assert.notEqual(theirs.bySpace.get("space"), asked);
});

/* The asynchronous half of the message path as the hook runs it: the real
   resolve-into-store and window coordinators, a real QueryClient and entity
   collection, real leases, and reads this test holds until it lets them go. */
async function openResolveOwner() {
  const { QueryClient } = require("@tanstack/react-query");
  const refresh = require("./channel-catalog-refresh.ts");
  const { createRealtimeCollection } = require("./realtime-collection.ts");
  const { createViewerReads } = require("./channel-message-summary.ts");
  const session = "xmatrix\u0000hub\u0000user";
  const prefix = ["xmatrix", "hub", "user", "channels", "space"];
  const conversations = [...prefix, "catalog", "flat", "all", null, ""];
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const store = createRealtimeCollection([]);
  let reads = createViewerReads();
  let leases = refresh.nextCatalogLeases(refresh.NO_CATALOG_LEASES, session, ["space"]);
  const published = [];
  store.subscribe(() => published.push(store.getSnapshot().map((channel) => channel.id)));
  const fetched = [];
  const page = (rows) => ({ rows, protocolVersion: 1, catalogRevision: 4, nextCursor: null, counts: null });
  await client.fetchQuery({ queryKey: conversations, structuralSharing: refresh.shareCatalogRows, queryFn: async () => {
    fetched.push("conversations");
    return { pages: [page([catalogRow("first", "2026-10-06T00:00:00.000Z")])], pageParams: [null] };
  } });
  fetched.length = 0;
  const held = [];
  // One request as the hook admits it: the lease it was asked under, the Hub's answer held by the test.
  const ask = (unknown, limit = 200) => {
    const lease = leases.bySpace.get("space");
    const authorized = () => lease !== undefined && leases.bySpace.get("space") === lease;
    return refresh.resolveWindowChannels({
      client, spaceId: "space", prefix, countsKey: [...prefix, "catalog-counts"], viewerId: "user",
      hasChannel: (id) => reads.has(id) && store.get(id) !== undefined, channel: (id) => store.get(id),
      resolveChannel: () => assert.fail("a window's unknown Channels are one read"),
      unknown, limit, authorized,
      resolve: async (channelIds) => (await refresh.readChannelsIntoStore({
        authorized,
        read: () => new Promise((resolve, reject) => held.push({ channelIds, resolve, reject })),
        commit: (channels) => store.set((current) => [...current, ...channels.map((channel) => reads.settle(channel))]),
      })).channels,
    });
  };
  const answer = (request) => request.resolve({ protocolVersion: 1, pathsByChannelId: {},
    channels: request.channelIds.map((id) => ({ id, spaceId: "space", readSequence: 40, messageCount: 41 })) });
  return {
    client, store, published, fetched, held, ask, answer, conversations,
    listed: () => client.getQueryData(conversations).pages[0].rows.map((row) => row.channel.id),
    hasRead: (id) => reads.has(id),
    // What the shell does when the sign-in or the Space goes: no Space is admitted and the table is emptied.
    retract() { leases = refresh.nextCatalogLeases(leases, session, []); reads = createViewerReads(); store.set([]); published.length = 0; },
    restore() { leases = refresh.nextCatalogLeases(leases, session, ["space"]); },
    renewToken() { leases = refresh.nextCatalogLeases(leases, session, ["space"]); },
    settled: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

const unknownMessage = (channelId) => ({ kind: "message", channelId, at: "2026-10-06T05:00:00.000Z" });

test("the Hub's answer for a Channel nobody knew brings it to this reader, once", async () => {
  const t = await openResolveOwner();
  try {
    const done = t.ask([unknownMessage("far")]);
    t.renewToken();
    t.answer(t.held[0]);
    await done;
    assert.deepEqual(t.store.getSnapshot().map((channel) => channel.id), ["far"]);
    assert.equal(t.hasRead("far"), true);
    assert.deepEqual(t.listed(), ["far", "first"]);
    assert.equal(t.published.length, 1);
    await t.settled();
    assert.deepEqual(t.fetched, []);
  } finally { t.client.clear(); }
});

test("an answer that comes after the sign-in or the Space went writes nothing, even once they are back", async () => {
  const t = await openResolveOwner();
  try {
    // Asked, then the authorization ends and the table is emptied, then the answer.
    const gone = t.ask([unknownMessage("far")]);
    t.retract();
    t.answer(t.held[0]);
    await gone;
    assert.deepEqual(t.store.getSnapshot(), []);
    assert.deepEqual(t.published, []);
    assert.equal(t.hasRead("far"), false);
    assert.deepEqual(t.listed(), ["first"]);

    // Asked, ended, and the same account and Space are back before the old answer arrives.
    t.restore();
    const old = t.ask([unknownMessage("older")]);
    t.retract();
    t.restore();
    t.answer(t.held[1]);
    await old;
    assert.deepEqual(t.store.getSnapshot(), []);
    assert.equal(t.hasRead("older"), false);
    assert.deepEqual(t.listed(), ["first"]);
    // What is asked under the new authorization is answered as usual.
    const fresh = t.ask([unknownMessage("older")]);
    t.answer(t.held[2]);
    await fresh;
    assert.deepEqual(t.store.getSnapshot().map((channel) => channel.id), ["older"]);
    assert.deepEqual(t.listed(), ["older", "first"]);
    await t.settled();
    assert.deepEqual(t.fetched, []);
  } finally { t.client.clear(); }
});

test("a window's reads that end on both sides of a lost sign-in list nothing and read nothing again", async () => {
  const t = await openResolveOwner();
  try {
    // Two reads for one window. The first is answered and committed; the sign-in goes; the second is answered.
    const both = t.ask([unknownMessage("far"), unknownMessage("farther")], 1);
    t.answer(t.held[0]);
    await t.settled();
    assert.deepEqual(t.store.getSnapshot().map((channel) => channel.id), ["far"]);
    t.retract();
    t.answer(t.held[1]);
    await both;
    assert.deepEqual(t.store.getSnapshot(), []);
    assert.deepEqual(t.published, []);
    assert.deepEqual(t.listed(), ["first"]);

    // The same with a read that fails after the sign-in went: nothing falls back to reading the lists.
    t.restore();
    const failing = t.ask([unknownMessage("far"), unknownMessage("farther")], 1);
    t.answer(t.held[2]);
    await t.settled();
    t.retract();
    t.held[3].reject(new Error("cancelled"));
    await failing;
    await t.settled();
    assert.deepEqual(t.fetched, []);
    assert.deepEqual(t.listed(), ["first"]);
  } finally { t.client.clear(); }
});

test("an authorization reads for itself: no read under way and no fresh answer of one that ended is handed on", async () => {
  const { QueryClient } = require("@tanstack/react-query");
  const refresh = require("./channel-catalog-refresh.ts");
  const { createViewerReads, readAskedNow } = require("./channel-message-summary.ts");
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const session = "xmatrix\u0000hub\u0000user";
  const reads = createViewerReads();
  const outdated = [];
  // Who asks, in which Space, for which Channels: the same for every read below.
  const queryKey = ["xmatrix", "hub", "user", "channels", "space", "resolve", ["far"], null, true];
  let leases = refresh.nextCatalogLeases(refresh.NO_CATALOG_LEASES, session, ["space"]);
  const asked = [];
  const committed = [];
  // The hook's own read: a real fetchQuery of the leased query, its commit behind the lease.
  const read = () => {
    const lease = leases.bySpace.get("space");
    return refresh.readChannelsIntoStore({
      authorized: () => lease !== undefined && leases.bySpace.get("space") === lease,
      read: () => client.fetchQuery(refresh.leasedResolveQuery({ queryKey, lease, asked: readAskedNow,
        read: () => new Promise((resolve) => asked.push((revision) => resolve(
          { protocolVersion: 1, pathsByChannelId: {}, channels: [{ id: "far", spaceId: "space", revision }] }))) })),
      commit: (channels) => {
        committed.push(...channels.map((channel) => channel.revision));
        outdated.push(...channels.map((channel) => reads.outdated(channel)));
      },
    });
  };
  const signInLostAndBack = () => {
    leases = refresh.nextCatalogLeases(leases, session, []);
    leases = refresh.nextCatalogLeases(leases, session, ["space"]);
  };
  try {
    // A read is under way when the sign-in is lost and comes back with the same values.
    const old = read();
    signInLostAndBack();
    const current = read();
    await new Promise((resolve) => setImmediate(resolve));
    // The new authorization asked the Hub itself instead of waiting on the old one's read.
    assert.equal(asked.length, 2);
    asked[0]("read for the authorization that ended");
    asked[1]("read for this one");
    await Promise.all([old, current]);
    assert.deepEqual(committed, ["read for this one"]);

    // An answer still fresh in the cache is this authorization's own: the next read reuses it.
    await read();
    assert.equal(asked.length, 2);
    assert.deepEqual(committed, ["read for this one", "read for this one"]);
    // It is not the next authorization's: that one asks again.
    signInLostAndBack();
    const next = read();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(asked.length, 3);
    // The Hub answers the reader's read state while that read is under way:
    // the read was asked before the answer, and its Channels say so.
    reads.answered("far");
    asked[2]("read after coming back again");
    await next;
    assert.equal(committed.at(-1), "read after coming back again");
    assert.deepEqual(outdated, [false, false, true]);
  } finally { client.clear(); }
});

test("a read that fails while its authorization stands leaves the list to be read again", async () => {
  const t = await openResolveOwner();
  try {
    const failing = t.ask([unknownMessage("far")]);
    t.held[0].reject(new Error("network"));
    await failing;
    await t.settled();
    assert.deepEqual(t.fetched, ["conversations"]);
    assert.deepEqual(t.store.getSnapshot(), []);
  } finally { t.client.clear(); }
});

// Run the real `pageFromCache` so this fails on the readiness it reports.
function loadPageFromCache() {
  const ts = require("typescript");
  const { extractFunctionSource } = require("./workspace-shell-source-fixture.cjs");
  // rowsFromData is shared with the refresh path and lives in its own module.
  const source = [
    extractFunctionSource(refresh, "rowsFromData", {
      fileName: "channel-catalog-refresh.ts",
    }),
    extractFunctionSource(paging, "pageFromCache", { fileName: "use-channel-catalog-paging.ts" }),
  ].join("\n\n");
  const compiled = ts.transpileModule(`${source}\nexports.pageFromCache = pageFromCache;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exported = {};
  new Function("exports", compiled)(exported);
  return exported.pageFromCache;
}

function cacheOf(data) {
  return {
    getQueryState: () => data === undefined
      ? undefined
      : { data, fetchStatus: "idle", status: "success" },
  };
}

function catalogPage(rows, extra = {}) {
  return {
    protocolVersion: 1,
    catalogRevision: 0,
    rows,
    nextCursor: null,
    counts: { active: 0, archive: 0, unread: 0, mentions: 0 },
    ...extra,
  };
}

test("a page is loaded once the catalog has answered, even when it is empty", () => {
  const pageFromCache = loadPageFromCache();
  const answered = pageFromCache(cacheOf({ pages: [catalogPage([])], pageParams: [null] }), ["key"]);
  assert.deepEqual(answered.rows, []);
  assert.equal(answered.loaded, true);
  assert.equal(pageFromCache(cacheOf(undefined), ["key"]).loaded, false);
});

test("catalog revisions discard unopened speculative pages without crossing Space identity", async () => {
  const { QueryClient } = require("@tanstack/react-query");
  const { observeSpaceCatalogRevision, refreshSpaceCatalogForEvent } = require("./channel-catalog-refresh.ts");
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const prefix = ["xmatrix", "hub", "user", "channels", "space"];
  const speculative = [...prefix, "child-prefetch", "tree", "all", "parent", ""];
  const other = ["xmatrix", "hub", "other-user", "channels", "space", "child-prefetch", "tree", "all", "parent", ""];
  const page = { pages: [{ catalogRevision: 3, rows: [] }], pageParams: [null] };
  try {
    client.setQueryData(speculative, page);
    client.setQueryData(other, page);
    observeSpaceCatalogRevision({ client, spaceId: "space", prefix,
      countsKey: [...prefix, "catalog-counts"], revision: 4 });
    assert.equal(client.getQueryData(speculative), undefined);
    assert.deepEqual(client.getQueryData(other), page);
    client.setQueryData(speculative, page);
    refreshSpaceCatalogForEvent({ client, spaceId: "space", prefix,
      countsKey: [...prefix, "catalog-counts"], detail: { kind: "structure" },
      hasChannel: () => true, resolveChannel: () => {} });
    assert.equal(client.getQueryData(speculative), undefined);
    assert.deepEqual(client.getQueryData(other), page);
  } finally { client.clear(); }
});
