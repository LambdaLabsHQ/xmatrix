const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const paging = fs.readFileSync(path.join(__dirname, "use-channel-catalog-paging.ts"), "utf8").replace(/\r\n/g, "\n");

const refresh = fs.readFileSync(path.join(__dirname, "channel-catalog-refresh.ts"), "utf8");

async function openCatalogRefresh() {
  const { QueryClient } = require("@tanstack/react-query");
  const { refreshSpaceCatalogForEvent } = await import("./channel-catalog-refresh.ts");
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
  const { refreshSpaceCatalogForMessages } = await import("./channel-catalog-refresh.ts");
  const prefix = ["xmatrix", "hub", "user", "channels", "space"];
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const fetched = [];
  const page = (rows, nextCursor = null) => ({ rows, protocolVersion: 1, catalogRevision: 4, nextCursor, counts: null });
  const hold = async (key, pages) => client.fetchQuery({ queryKey: key, queryFn: async () => {
    fetched.push(key[6] + ":" + key[7]);
    return { pages, pageParams: pages.map((_, index) => index ? `cursor-${index}` : null) };
  } });
  return { refreshSpaceCatalogForMessages, client, prefix, fetched, page, hold,
    conversations: [...prefix, "catalog", "flat", "all", null, ""],
    unread: [...prefix, "catalog", "flat", "unread", null, ""],
    countsKey: [...prefix, "catalog-counts"] };
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
    const resolved = [];
    t.refreshSpaceCatalogForMessages({
      client: t.client, spaceId: "space", prefix: t.prefix, countsKey: t.countsKey, viewerId: "user",
      details: [
        { kind: "message", channelId: "quiet", at: "2026-10-06T02:00:00.000Z" },
        { kind: "message", channelId: "paged", at: "2026-10-06T03:00:00.000Z" },
      ],
      hasChannel: (id) => entities.has(id), channel: (id) => entities.get(id),
      resolveChannel: (...args) => resolved.push(args),
    });
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
    const resolved = [];
    t.refreshSpaceCatalogForMessages({
      client: t.client, spaceId: "space", prefix: t.prefix, countsKey: t.countsKey, viewerId: "user",
      details: ["theirs", "mine", "elsewhere", "unknown"].map((channelId) => ({ kind: "message", channelId })),
      hasChannel: (id) => entities.has(id), channel: (id) => entities.get(id),
      resolveChannel: (...args) => resolved.push(args),
    });
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
  const { refreshSpaceCatalogForMessages, shareCatalogRows } = await import("./channel-catalog-refresh.ts");
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
  const { observeSpaceCatalogRevision, refreshSpaceCatalogForEvent } = await import("./channel-catalog-refresh.ts");
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
