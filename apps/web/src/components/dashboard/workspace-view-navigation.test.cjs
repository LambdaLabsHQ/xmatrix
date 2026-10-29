const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { adminViewPath, viewSelectionPath } = require("./workspace-shell-navigation.ts");

test("Apps canonicalization removes item and preserves connector return parameters", () => {
  const path = adminViewPath("/app/lambda/apps",
    "/app/space-id/apps?item=github&connector=gmail&gmailWatchState=state&gmailWatchCode=code&oauth=connected");
  const query = new URL(path, "https://xmatrix.test").searchParams;
  assert.equal(query.has("item"), false);
  assert.equal(query.get("connector"), "gmail");
  assert.equal(query.get("gmailWatchState"), "state");
  assert.equal(query.get("gmailWatchCode"), "code");
  assert.equal(query.get("oauth"), "connected");
});

test("each destination owns a semantic field and no item alias", () => {
  for (const [view, parameter] of [["agents", "agent"], ["machines", "machine"], ["automation", "schedule"], ["settings", "section"], ["admin", "section"], ["team", "space"]]) {
    assert.equal(viewSelectionPath(`/app/lambda/${view}`, `/app/lambda/${view}?${parameter}=selected&item=old`), `/app/lambda/${view}?${parameter}=selected`);
    assert.equal(viewSelectionPath(`/app/lambda/${view}`, `/app/lambda/${view}?item=old`), `/app/lambda/${view}`);
  }
});
