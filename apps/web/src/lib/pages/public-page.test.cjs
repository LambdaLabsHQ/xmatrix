const assert = require("node:assert/strict");
const test = require("node:test");
const { installTypeScriptRequire } = require("../../components/dashboard/typescript-require.cjs");

installTypeScriptRequire();
const { loadPublicPage } = require("./public-page.ts");

test("loadPublicPage uses cache no-store instead of Next incremental revalidation", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ page: { pageId: "p-1" }, present: [] });
  };
  try {
    const loaded = await loadPublicPage("s/1", "p 1");
    assert.deepEqual(loaded, { page: { pageId: "p-1" }, present: [] });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].url), /\/api\/public\/spaces\/s%2F1\/pages\/p%201$/u);
    assert.equal(calls[0].init?.cache, "no-store");
    assert.equal(calls[0].init?.next, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadPublicPage returns null on 404 and throws on server failure", async () => {
  const originalFetch = globalThis.fetch;
  let status = 404;
  globalThis.fetch = async () => new Response(null, { status });
  try {
    assert.equal(await loadPublicPage("s-1", "missing"), null);
    status = 502;
    await assert.rejects(() => loadPublicPage("s-1", "broken"), /public page unavailable \(502\)/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
