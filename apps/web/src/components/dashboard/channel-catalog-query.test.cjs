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
const { fetchChannelCatalogPage, fetchChannelCatalogResolve, normalizeChannelCatalogQuery } =
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
