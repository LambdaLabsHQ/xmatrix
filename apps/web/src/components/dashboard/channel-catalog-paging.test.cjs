const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const paging = fs.readFileSync(path.join(__dirname, "use-channel-catalog-paging.ts"), "utf8").replace(/\r\n/g, "\n");

const refresh = fs.readFileSync(path.join(__dirname, "channel-catalog-refresh.ts"), "utf8");

test("message activity refreshes unloaded flat rows and inactive filtered lists within its Space", async () => {
  const { QueryClient } = require("@tanstack/react-query");
  const { refreshSpaceCatalogForEvent } = await import("./channel-catalog-refresh.ts");
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const prefix = ["xmatrix", "hub", "user", "channels", "space"];
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
