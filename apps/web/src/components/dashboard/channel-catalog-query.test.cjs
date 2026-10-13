const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const { QueryClient } = require("@tanstack/react-query");
const { installTypeScriptRequire } = require("./typescript-require.cjs");

installTypeScriptRequire();

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolve(request, parent, ...rest) {
  if (request === "@/lib/query/api-client") {
    return path.join(__dirname, "../../lib/query/api-client.ts");
  }
  if (request === "./workspace-admin-views") return path.join(__dirname, "channel-catalog-query.test.cjs");
  return resolveFilename.call(this, request, parent, ...rest);
};
const { fetchChannelCatalogPage, fetchChannelCatalogCounts, fetchChannelCatalogResolve, normalizeChannelCatalogQuery } =
  require("./channel-catalog-query.ts");
const { shouldRetryXMatrixQuery } = require("../../lib/query/api-client.ts");
Module._resolveFilename = resolveFilename;

const page = { protocolVersion: 1, catalogRevision: 1, rows: [], nextCursor: null };

test("a dropped connection while loading the catalog is retried, not shown", async (t) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryXMatrixQuery, retryDelay: 0 } } });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(page), { status: 200 });
  });
  const value = await client.fetchQuery({
    queryKey: ["catalog"],
    queryFn: ({ signal }) => fetchChannelCatalogPage({
      token: "t", spaceId: "space", query: normalizeChannelCatalogQuery({ view: "flat" }), signal,
    }),
  });
  assert.deepEqual(value, page);
  assert.equal(calls, 2);
  client.clear();
});

test("a dropped connection while resolving catalog rows is retryable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(
    fetchChannelCatalogResolve({ token: "t", spaceId: "space", channelIds: ["c"] }),
    (error) => error.status === 0 && shouldRetryXMatrixQuery(0, error),
  );
});

const catalogReads = {
  page: (signal) => fetchChannelCatalogPage({
    token: "t", spaceId: "space", query: normalizeChannelCatalogQuery({ view: "flat" }), signal,
  }),
  counts: (signal) => fetchChannelCatalogCounts({ token: "t", spaceId: "space", signal }),
  resolve: (signal) => fetchChannelCatalogResolve({ token: "t", spaceId: "space", channelIds: ["c"], signal }),
};
const counts = { active: 1, unread: 0, mentions: 0 };
const resolved = { protocolVersion: 1, channels: [], pathsByChannelId: {} };

for (const [name, read] of Object.entries(catalogReads)) {
  test(`catalog ${name} retries a connection lost after HTTP 200 headers`, async (t) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryXMatrixQuery, retryDelay: 0 } } });
    t.after(() => client.clear());
    let calls = 0;
    const answer = name === "resolve" ? resolved : { ...page, counts };
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls === 1) return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError("Failed to fetch")); },
      }), { status: 200 });
      return Response.json(answer);
    });
    assert.deepEqual(await client.fetchQuery({ queryKey: [name], queryFn: ({ signal }) => read(signal) }),
      name === "counts" ? counts : answer);
    assert.equal(calls, 2);
  });

  test(`catalog ${name} keeps malformed JSON a defect without exposing body snippets`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("private response text", {
      headers: { "content-type": "text/html" },
    }));
    await assert.rejects(read(), (error) => error instanceof SyntaxError &&
      error.message === "Invalid JSON response (HTTP 200; nonempty; media=html)" &&
      !shouldRetryXMatrixQuery(0, error));
  });
}

test("catalog body failure preserves the caller's cancellation", async (t) => {
  const controller = new AbortController();
  const cause = new TypeError("Failed to fetch");
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(body) { controller.abort(cause); body.error(cause); },
  })));
  await assert.rejects(catalogReads.page(controller.signal), (error) => error === cause);
});

test("a persistent catalog body disconnect stops after three attempts with a network outcome", async (t) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryXMatrixQuery, retryDelay: 0 } } });
  t.after(() => client.clear());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(new ReadableStream({
      start(body) { body.error(new TypeError("Failed to fetch")); },
    }));
  });
  await assert.rejects(client.fetchQuery({ queryKey: ["persistent"], queryFn: ({ signal }) => catalogReads.page(signal) }),
    (error) => error.status === 0 && error.code === "network_error" && error.persistent);
  assert.equal(calls, 3);
});
