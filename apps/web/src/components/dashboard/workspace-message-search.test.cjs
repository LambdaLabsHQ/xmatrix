const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const { searchWorkspaceMessages, searchWorkspacePages } = require("./workspace-message-search.ts");

for (const [kind, read] of [["message", searchWorkspaceMessages], ["page", searchWorkspacePages]]) {
  test(`a ${kind} search page without results is refused where it is read; an empty page is still a page`, async (t) => {
    let payload;
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    for (payload of [{}, null, { results: null }, { results: {} }]) {
      await assert.rejects(read({ token: "token", spaceId: "space", query: "agent" }),
        (error) => error.name === "XMatrixApiError" && error.code === "unexpected_response");
    }
    payload = { results: [], execution: "proven" };
    assert.deepEqual(await read({ token: "token", spaceId: "space", query: "agent" }), payload);
  });
}
